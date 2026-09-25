// Consensus: approvals of a task version, and the rule that decides whether an approval is
// independent at all.
//
// Proposals used to live here too — an agent put a role change, a handoff or a decision to the room,
// every connected teammate voted, and an adopted one created or moved real work. It went with the
// per-project role vocabulary it mostly existed to negotiate: with three fixed roles there is
// nothing to appoint anyone to, a handoff is a planner creating the assignment again for someone
// else, and a decision is a note on the board. One human at a keyboard does not need a quorum.
//
// The invariant with the most history behind it lives here. An agent may not verify work it wrote,
// enforced at claim time by _verifierIsAuthor rather than only at approval — refusing it only at
// approval meant the author was handed the review, read the whole diff, and found that its single
// exit was to block the assignment. _independentClaimantExists is the solo-mode half: on a project
// that turned solo mode on, with no independent teammate who could actually take it, the author
// still gets the work and the acceptance is labeled selfReviewed. With solo mode off the review waits.
//
// A mixin on DevTeamStore.prototype, for the reasons in store-checks.mjs. The scheduler in store.mjs
// calls _verifierIsAuthor and _findingsFor directly, which is exactly why those had to stop being
// #private: a mixin and its class cannot share one.
import { randomUUID } from "node:crypto";
import { fromJson, json, now } from "./util.mjs";
// A cycle (store.mjs imports this mixin), which is safe: reconnectGraceCutoff is only called at run
// time, long after both modules have finished evaluating.
import { reconnectGraceCutoff } from "./store.mjs";
import { redact } from "./knowledge.mjs";
import { CHECKLIST_RULE_MAX } from "./checklists.mjs";

// Whether an assignment reads the work rather than changing it — and therefore waits for pending
// writers, earns the right to approve, and puts its task in review — is a column on the row,
// resolved from the role when the assignment was created (see roles.mjs). Keeping it as a column
// rather than a list of role names in this SQL is what let the vocabulary change without touching
// the scheduler, twice now.
const VERIFIES = "verifies = 1";

export const consensusMethods = {

  // Did this assignment read the work rather than change it? Asked of the assignment row rather than
  // of the role name recorded on the event, so a project that renamed its reviewing role still earns
  // approval standing, and a role renamed *after* the fact cannot retroactively grant it.
  _assignmentVerifies(assignmentId) {
    if (!assignmentId) return false;
    return Boolean(this.db.prepare("SELECT verifies FROM assignments WHERE id = ?").get(assignmentId)?.verifies);
  },

  // Connected agents that belong to a given task.
  _connectedMemberIds(taskId) {
    const connected = this.db.prepare("SELECT id FROM agents WHERE status != 'disconnected'").all().map((row) => row.id);
    return connected.filter((id) => this._memberTaskIds(id).includes(taskId));
  },

  // Who counts as one participant. This followed claimed checkpoint links back to an original
  // session, because a takeover minted a fresh agent id for the same person and an author must not
  // become their own independent reviewer by handing themselves the session. Checkpoints are gone,
  // no other path mints a second id for one participant, and so identity is the whole answer.
  _connectedParticipants(taskId) {
    const members = this.db.prepare(`
      SELECT tm.agent_id FROM task_members tm
      JOIN agents agent ON agent.id = tm.agent_id
      WHERE tm.task_id = ? AND tm.role = 'contributor' AND agent.status != 'disconnected'
    `).all(taskId);
    return new Set(members.map((member) => member.agent_id));
  },

  // Who wrote the version under review — as *people*, not as sessions.
  //
  // An agent row is one connection. Reconnect and you are a new row with a new id, so a set of
  // author ids stopped recognising the author the moment it went away and came back: DevTeam handed
  // Claude a "fresh specification review" of code Claude had written twenty minutes earlier, in the
  // previous session, with nothing in the payload saying so. The guarantee had not been removed,
  // only quietly emptied — which is worse, because the verdict still reads as independent.
  //
  // So the author set is widened to every session that same participant has ever had here. Identity
  // is the name and provider the participant connects under, which is what a human means by "Codex"
  // or "Claude" and the only handle that survives a reconnect. Two genuinely different participants
  // sharing one name and provider would be treated as one, and that is the right way to be wrong:
  // it withholds a review, it never lets an author approve their own work.
  _currentVersionAuthors(taskId, version) {
    const authors = this.db.prepare(`
      SELECT agent_id, metadata FROM events
      WHERE task_id = ? AND type = 'assignment.completed' AND agent_id IS NOT NULL
    `).all(taskId).filter((event) => {
      const metadata = fromJson(event.metadata, {});
      return metadata.version === version && Array.isArray(metadata.changedFiles) && metadata.changedFiles.length > 0;
    });
    return this._widenParticipantSessions(authors.map((author) => author.agent_id));
  },

  _widenParticipantSessions(authorIds) {
    const ids = new Set(authorIds.filter(Boolean));
    if (!ids.size) return ids;
    const placeholders = [...ids].map(() => "?").join(",");
    const sessions = this.db.prepare(`
      SELECT session.id FROM agents session
      JOIN agents author
        ON lower(session.name) = lower(author.name)
       AND lower(COALESCE(session.provider, '')) = lower(COALESCE(author.provider, ''))
      WHERE author.id IN (${placeholders})
    `).all(...ids);
    for (const session of sessions) ids.add(session.id);
    return ids;
  },

  _reviewAuthors(assignment) {
    if (!assignment.review_subject_assignment_id) return this._currentVersionAuthors(assignment.task_id, assignment.task_version);
    const subject = this.db.prepare("SELECT task_id, agent_id, status FROM assignments WHERE id = ?").get(assignment.review_subject_assignment_id);
    if (!subject || subject.task_id !== assignment.task_id || subject.status !== "done") return this._currentVersionAuthors(assignment.task_id, assignment.task_version);
    return this._widenParticipantSessions([subject.agent_id]);
  },

  _approvers(taskId, version) {
    const approvals = this.db.prepare("SELECT agent_id FROM approvals WHERE task_id = ? AND version = ?").all(taskId, version);
    return new Set(approvals.map((approval) => approval.agent_id));
  },

  _eligibleIndependentApprovers(taskId, version) {
    const authors = this._currentVersionAuthors(taskId, version);
    return new Set([...this._connectedParticipants(taskId)].filter((agentId) => !authors.has(agentId)));
  },

  // Reviewer ≠ author, asked at claim time. approveTask has always refused a self-approval, but
  // refusing it *only* there meant the author was handed the review claim, read the whole diff, and
  // then found the single exit was to block the assignment: seven blocked assignments on this board
  // are exactly that refusal, the most recent from 2026-08-27, and they are why 264 completed
  // assignments produced two requests for changes. Enforcing it where the claim is handed out costs
  // the team nothing and is the difference between independent review and a rubber stamp.
  //
  // With no independent teammate connected, what happens is the project's choice. Solo mode on: the
  // author still gets the work and the acceptance is labeled selfReviewed rather than the assignment
  // sitting claimable-by-nobody. Solo mode off (the default): the review waits, and the board says
  // who it is waiting for.
  //
  // Off is the default because "no dead-ends" turned out to be the wrong trade for a team whose
  // reviewer connects one turn at a time. Codex opens a fresh session per turn, so between turns
  // Claude was the only contributor present, was handed reviews of its own code, refused them under
  // the owner's rule, and every refusal queued a planner card: 42 of Stuff Downloader's 62 blocked
  // reports were exactly that loop. Waiting costs a visible pause; the loop cost the board.
  _verifierIsAuthor(agentId, assignment) {
    const authors = this._reviewAuthors(assignment);
    if (!authors.has(agentId)) return false;
    if (!this._soloReviewAllowed(assignment.task_id)) return true;
    return this._independentClaimantExists(assignment, authors, agentId);
  },

  _soloReviewAllowed(taskId) {
    return Boolean(this.db.prepare(`
      SELECT p.solo_review FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?
    `).get(taskId)?.solo_review);
  },

  // "Could somebody else actually take this, right now?" — deliberately not "does an independent
  // teammate exist". The difference is a deadlock, and the property suite found it on the first try:
  // a teammate who is connected but already holding as much work as it can take will never claim
  // this item, so excluding the author on its behalf leaves the assignment queued forever with a
  // reason that reads like a promise nobody is going to keep.
  //
  // Asked through the full explanation surface rather than a hand-rolled subset of it, so this can
  // never drift from what the scan will really do with that teammate.
  //
  // The recursion terminates at one level: whyNotClaimable consults _verifierIsAuthor in turn, but
  // only for the teammates asked about here, and those are non-authors by construction — the author
  // test above returns false for them before reaching this method again.
  _independentClaimantExists(assignment, authors, excludeAgentId) {
    const members = this.db.prepare(`
      SELECT tm.agent_id FROM task_members tm
      JOIN agents agent ON agent.id = tm.agent_id
      WHERE tm.task_id = ? AND tm.role = 'contributor' AND agent.status != 'disconnected'
    `).all(assignment.task_id);
    for (const member of members) {
      if (member.agent_id === excludeAgentId) continue;
      if (authors.has(member.agent_id)) continue;
      if (this.whyNotClaimable(assignment.id, member.agent_id, { refreshLiveness: false }).claimable) return true;
    }
    // A teammate whose transport dropped moments ago is most likely reconnecting as a new session.
    // Handing the author its own review inside that gap is exactly how self-review slipped past an
    // assigned independent reviewer, so wait out the grace window — unless that teammate is already
    // back under a live session, in which case the loop above has given its real answer.
    const reconnecting = this.db.prepare(`
      SELECT agent.name FROM task_members tm
      JOIN agents agent ON agent.id = tm.agent_id
      WHERE tm.task_id = ? AND tm.role = 'contributor' AND agent.id != ?
        AND agent.status = 'disconnected' AND agent.disconnect_kind = 'transport' AND agent.disconnected_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM agents live WHERE lower(live.name) = lower(agent.name) AND live.status != 'disconnected'
        )
    `).all(assignment.task_id, excludeAgentId, reconnectGraceCutoff());
    // An author's own earlier session reconnecting is not an independent reviewer on the way back.
    const nameOf = this.db.prepare("SELECT lower(name) AS name FROM agents WHERE id = ?");
    const authorNames = new Set([...authors].map((id) => nameOf.get(id)?.name).filter(Boolean));
    return reconnecting.some((row) => !authorNames.has(row.name.toLowerCase()));
  },

  // No dead-ends: configured consensus cannot exceed the independent teammates who could
  // actually approve now. With none available, one honest self-review remains sufficient.
  _effectiveRequiredApprovals(taskId, configured, version) {
    const eligible = this._eligibleIndependentApprovers(taskId, version).size;
    return Math.max(1, Math.min(configured, eligible || 1));
  },

  approveTask({ agentId, taskId, summary }) {
    const agent = this.getAgent(agentId);
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    if (["blocked", "cancelled"].includes(task.status)) throw new Error(`Cannot approve a ${task.status} task.`);
    if (task.status === "accepted") {
      return { accepted: true, approvalCount: task.required_approvals, requiredApprovals: task.required_approvals, openAssignments: 0, version: task.version };
    }
    const reviewEvidence = this.db.prepare(`
      SELECT metadata FROM events
      WHERE task_id = ? AND agent_id = ? AND type = 'assignment.completed'
      ORDER BY id DESC
    `).all(taskId, agentId).some((event) => {
      const metadata = fromJson(event.metadata, {});
      return metadata.version === task.version
        && this._assignmentVerifies(metadata.assignmentId)
        && (!Array.isArray(metadata.changedFiles) || metadata.changedFiles.length === 0);
    });
    if (!reviewEvidence) throw new Error("Approval requires a completed, read-only reviewer assignment on the current task version.");
    // Reviewer ≠ author: when the team is more than one agent, the author of the current version
    // cannot approve it — an independent teammate must. With solo mode on, a genuine solo run is
    // still allowed to finish, but its acceptance is labeled selfReviewed so it is never mistaken
    // for independent consensus. With solo mode off, the author never approves its own version.
    const authors = this._currentVersionAuthors(taskId, task.version);
    const eligibleIndependent = this._eligibleIndependentApprovers(taskId, task.version);
    if (authors.has(agentId) && eligibleIndependent.size > 0) {
      throw new Error("The author of the current version cannot approve it; an independent reviewer must.");
    }
    if (authors.has(agentId) && !this._soloReviewAllowed(taskId)) {
      throw new Error("You wrote the current version, and solo mode is off for this project, so a reviewer who did not write it has to approve it.");
    }
    let outcome;
    this._transaction(() => {
      const stamp = now();
      // Independence is recorded on the approval, not recomputed later. Whether the approver was the
      // author is a fact about the moment of approving; recomputing it lets the record change as
      // agents connect and disconnect, which is exactly when it must not.
      const independent = !authors.has(agentId);
      this.db.prepare(`
        INSERT INTO approvals (task_id, agent_id, version, summary, created_at, independent)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, agent_id, version) DO UPDATE SET summary = excluded.summary, created_at = excluded.created_at,
          independent = excluded.independent
      `).run(taskId, agentId, task.version, summary.trim(), stamp, independent ? 1 : 0);
      this._event(taskId, agentId, "task.approved",
        `${agent.name} approved version ${task.version}${independent ? "" : " (self-review: no independent teammate was available)"}.`,
        { summary: summary.trim(), version: task.version, independent });
      const approvers = this._approvers(taskId, task.version);
      const approvalCount = approvers.size;
      const openAssignments = Number(this.db.prepare("SELECT COUNT(*) AS count FROM assignments WHERE task_id = ? AND status IN ('queued', 'claimed')").get(taskId).count);
      const effectiveRequired = this._effectiveRequiredApprovals(taskId, task.required_approvals, task.version);
      const accepted = approvalCount >= effectiveRequired && openAssignments === 0;
      // Honest labeling: a lone participant reviewing itself is not consensus.
      const independentApprovalCount = [...approvers].filter((agent) => !authors.has(agent)).length;
      const selfReviewed = authors.size > 0 ? independentApprovalCount === 0 : approvers.size <= 1;
      if (accepted) {
        this.db.prepare("UPDATE tasks SET status = 'accepted', updated_at = ? WHERE id = ?").run(stamp, taskId);
        this._event(taskId, null, "task.accepted", `${selfReviewed ? "Self-reviewed acceptance" : "Consensus reached"} for version ${task.version}.`, { approvalCount, requiredApprovals: effectiveRequired, selfReviewed });
        // Keep the room's agents assembled (status 'waiting', membership intact) rather than force-
        // disconnecting them on acceptance, so the human can send a same-conversation follow-up that
        // continueTask reopens and the still-waiting agents pick up without restarting their sessions.
        // The continuation window in teamActivity keeps them from idling out before that follow-up.
        this.db.prepare(`
          UPDATE agents SET status = 'waiting', current_task_id = NULL, last_seen = ?
          WHERE (current_task_id = ? OR id IN (SELECT agent_id FROM approvals WHERE task_id = ?)) AND status != 'disconnected'
        `).run(stamp, taskId, taskId);
      } else {
        this.db.prepare("UPDATE tasks SET status = 'review', updated_at = ? WHERE id = ?").run(stamp, taskId);
      }
      outcome = { accepted, approvalCount, requiredApprovals: effectiveRequired, configuredApprovals: task.required_approvals, openAssignments, version: task.version, selfReviewed };
    });
    this._changed(outcome.accepted ? "task.accepted" : "task.approved", taskId);
    return outcome;
  },

  // A reviewer that finds problems used to have two moves, and both were wrong. Approving anyway is
  // dishonest; `status=blocked` closes the *reviewer's own* assignment and queues a coarse planner
  // item, so the fix routes through a human-shaped triage step instead of back to the person who
  // wrote the code. This is the third move: send the work itself back to its author, with the
  // findings attached, without stopping the task or disturbing anyone else's claim.
  //
  // What it deliberately does NOT do: create a new assignment. The original row is reopened, so its
  // title, description, checklist, write scope, dependencies and whole event history stay attached
  // to the work rather than being scattered across a chain of near-duplicate follow-ups. Reopening
  // clears the claim and its fencing token exactly as a force-release does, so a late report from
  // the author's previous session is refused instead of landing on top of the rework.
  requestChanges({ agentId = null, taskId, assignmentId, summary, findings = [] }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    if (["blocked", "cancelled", "accepted"].includes(task.status)) {
      throw new Error(`Cannot request changes on a ${task.status} task.`);
    }
    const agent = agentId ? this.getAgent(agentId) : null;
    const assignment = this.db.prepare("SELECT * FROM assignments WHERE id = ? AND task_id = ?").get(assignmentId, taskId);
    if (!assignment) throw new Error("Assignment not found in this task room.");
    if (assignment.status !== "done") {
      throw new Error(`Only completed work can be sent back for changes; this assignment is ${assignment.status}.`);
    }
    const cleanSummary = String(summary || "").trim();
    if (!cleanSummary) throw new Error("Say what needs to change.");
    // Earning the right to send work back is the same act as earning the right to approve it: an
    // independent read-only verifier assignment on the current version. The alternative is holding
    // that verifier claim right now — the reviewer that finds the problem mid-review should not have
    // to finish and file its own report before it can say so.
    if (agentId && !this._hasReviewStanding(agentId, taskId, task.version)) {
      throw new Error("Requesting changes needs a completed or in-progress read-only reviewer assignment on the current task version.");
    }
    const cleanFindings = (Array.isArray(findings) ? findings : []).slice(0, 50).map((item) => {
      const isObject = item && typeof item === "object" && !Array.isArray(item);
      return {
        detail: String((isObject ? item.detail : item) ?? "").trim().slice(0, 2000),
        path: isObject && item.path ? String(item.path).trim().slice(0, 500) : null,
        // Optional restatement as one short general lesson; redacted and capped when it is stored.
        // It is recorded with the finding and reaches the knowledge vault; the owner decides whether
        // it is worth a line in checklists/ (see checklists.mjs).
        rule: isObject && item.rule ? String(item.rule).trim().slice(0, CHECKLIST_RULE_MAX) : null,
        section: isObject && item.section ? String(item.section).trim().slice(0, 40) : null,
      };
    }).filter((item) => item.detail);
    const authorName = assignment.agent_id
      ? (this.db.prepare("SELECT name FROM agents WHERE id = ?").get(assignment.agent_id)?.name || null)
      : null;
    let outcome;
    this._transaction(() => {
      const stamp = now();
      const reworkCount = Number(assignment.rework_count || 0) + 1;
      // Back to queued, addressed to whoever wrote it. Targeting is a preference, not a lock: the
      // existing scheduler rule returns a targeted item to the general queue once nobody by that
      // name is connected, so rework never becomes unclaimable because its author went home.
      this.db.prepare(`
        UPDATE assignments
        SET status = 'queued', agent_id = NULL, completed_at = NULL, claim_token_hash = NULL,
            target_agent_name = COALESCE(?, target_agent_name),
            rework_count = ?, rework_requested_at = ?, rework_summary = ?
        WHERE id = ?
      `).run(authorName, reworkCount, stamp, cleanSummary, assignmentId);
      const storedFindings = cleanFindings.map((finding) => {
        const id = randomUUID();
        const rule = finding.rule ? redact(finding.rule) : null;
        this.db.prepare(`
          INSERT INTO assignment_findings (id, assignment_id, task_id, requested_by_agent_id, requested_by_name, task_version, detail, path, created_at, rule, section)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, assignmentId, taskId, agentId, agent?.name || "the human", Number(task.version), finding.detail, finding.path, stamp, rule, finding.section);
        return { ...finding, id, rule };
      });
      // The version under review was just judged not good enough, so approvals built on it no longer
      // describe a settled state. Clearing them is the same principle as version-invalidates-
      // approvals: if the rework changes files the version bumps and they would have gone anyway,
      // and if it changes none they would otherwise have survived a reviewer saying "not yet".
      const clearedApprovals = this.db.prepare("DELETE FROM approvals WHERE task_id = ? AND version = ?").run(taskId, task.version).changes;
      this._event(taskId, agentId, "assignment.changes_requested",
        `${agent?.name || "The human"} sent “${assignment.title}” back for changes: ${cleanSummary}`, {
          assignmentId,
          role: assignment.role,
          author: authorName,
          version: Number(task.version),
          reworkCount,
          clearedApprovals,
          findings: cleanFindings,
        });
      // The review that found this goes round again on the same card, instead of a new re-review card.
      const nextRound = this._rearmReviewOf(assignmentId, { reviewerAgentId: agentId, stamp });
      this._syncTaskStatus(taskId, stamp);
      outcome = {
        ...(nextRound ? { reviewRound: nextRound.round, reviewAssignmentId: nextRound.assignmentId } : {}),
        changesRequested: true,
        taskId,
        assignmentId,
        title: assignment.title,
        routedTo: authorName,
        reworkCount,
        clearedApprovals,
        findings: cleanFindings,
        version: Number(task.version),
      };
    });
    this._changed("assignment.changes_requested", taskId);
    return {
      ...outcome,
      next: outcome.routedTo
        ? `“${outcome.title}” is queued again and addressed to ${outcome.routedTo}. It stays claimable by the rest of the room if they are not connected.`
        : `“${outcome.title}” is queued again for whoever picks it up.`,
    };
  },

  // Whether this agent has earned a say on the current version: it either completed a read-only
  // verifier assignment on it (the same evidence approveTask requires) or is holding one right now.
  _hasReviewStanding(agentId, taskId, version) {
    const holding = this.db.prepare(`
      SELECT 1 FROM assignments
      WHERE task_id = ? AND agent_id = ? AND status = 'claimed' AND requires_write = 0
        AND ${VERIFIES} LIMIT 1
    `).get(taskId, agentId);
    if (holding) return true;
    return this.db.prepare(`
      SELECT metadata FROM events
      WHERE task_id = ? AND agent_id = ? AND type = 'assignment.completed'
      ORDER BY id DESC
    `).all(taskId, agentId).some((event) => {
      const metadata = fromJson(event.metadata, {});
      return metadata.version === version
        && this._assignmentVerifies(metadata.assignmentId)
        && (!Array.isArray(metadata.changedFiles) || metadata.changedFiles.length === 0);
    });
  },

  // Outstanding findings for an assignment: what the author is being asked to fix. Resolved rows are
  // kept so the history of a reworked piece of work stays legible.
  _findingsFor(assignmentId, { includeResolved = false } = {}) {
    return this.db.prepare(`
      SELECT id, requested_by_name, task_version, detail, path, created_at, resolved_at
      FROM assignment_findings
      WHERE assignment_id = ?${includeResolved ? "" : " AND resolved_at IS NULL"}
      ORDER BY created_at ASC, rowid ASC
    `).all(assignmentId);
  },
};
