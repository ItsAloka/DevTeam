// Changing cards that are already on the board: reopen, close, edit, and the review that comes back
// as its next round instead of as a new card.
//
// Before this, a card could only move forward. A blocked card stayed blocked forever, every card that
// waited on it waited forever, and neither an agent nor the owner had any way to close, re-point or
// edit one. So agents did the only thing they could — put a copy on the board — and Stuff Downloader
// ended up with 23 "(replacement)" cards, 36 separate re-review cards and 62 "Resolve blocker" cards
// out of 459. The owner cleaned up the last of them by blocking a whole task. Every action here exists
// so that fixing a card is cheaper than copying it.
//
// A mixin on DevTeamStore.prototype, for the reasons in store-checks.mjs.
import { now } from "./util.mjs";

const OPEN_FOR_EDIT = ["queued", "blocked"];
const MAX_BATCH = 30;

export const boardMethods = {
  // Who may change cards other agents will work from. The owner (no agentId) always may. An agent may
  // when the project names no planners, or when it is one of them — changing the board is planning.
  _assertMayChangeBoard(agentId, taskId) {
    if (!agentId) return;
    this.assertMembership(agentId, taskId);
    const task = this.getTask(taskId);
    const planners = this.projectTeam(task.project_id).planner || [];
    if (!planners.length) return;
    const agent = this.getAgent(agentId);
    if (planners.some((name) => name.toLowerCase() === String(agent.name).toLowerCase())) return;
    throw new Error(`Only ${planners.join(", ")} change the board on this project; ask them with devteam_message.`);
  },

  _boardCard(taskId, assignmentId) {
    const card = this.db.prepare("SELECT * FROM assignments WHERE id = ? AND task_id = ?").get(assignmentId, taskId);
    if (!card) throw new Error("Assignment not found in this task.");
    return card;
  },

  _actorName(agentId) {
    return agentId ? this.getAgent(agentId).name : "The owner";
  },

  // The planner cards a blocked card queued ("Resolve blocker: …") exist only to get that card
  // decided. Once it is decided — reopened or closed, by anyone — a still-queued one has nothing left
  // to do, so it is closed too rather than left for someone to claim and find nothing there.
  _settleResolvers(blockedId, stamp, how) {
    const resolvers = this.db.prepare(`
      SELECT id, title FROM assignments WHERE resolves_assignment_id = ? AND status = 'queued'
    `).all(blockedId);
    for (const resolver of resolvers) {
      this.db.prepare(`
        UPDATE assignments SET status = 'closed', completed_at = ?, closed_reason = ? WHERE id = ?
      `).run(stamp, `Decided already: ${how}.`, resolver.id);
    }
    return resolvers.length;
  },

  // Put a blocked or closed card back in the queue, optionally re-addressed and with a note the next
  // holder will read. Its title, checklist, write scope and dependencies are kept, so the cards that
  // were waiting on it are still waiting on it — which is the whole difference from a replacement.
  reopenAssignment({ agentId = null, taskId, assignmentId, targetAgentName = undefined, note = "" }) {
    this._assertMayChangeBoard(agentId, taskId);
    const task = this.getTask(taskId);
    if (["accepted", "blocked", "cancelled"].includes(task.status)) throw new Error(this.closedTaskError(task, "reopen its work"));
    const card = this._boardCard(taskId, assignmentId);
    if (!["blocked", "closed"].includes(card.status)) {
      throw new Error(card.status === "done"
        ? "This card is done. To send finished work back, request changes on it."
        : `This card is ${card.status}; only a blocked or closed card can be reopened.`);
    }
    const cleanNote = String(note || "").trim().slice(0, 4000);
    const stamp = now();
    const actor = this._actorName(agentId);
    this._transaction(() => {
      const description = cleanNote ? `${card.description}\n\nReopened by ${actor}: ${cleanNote}` : card.description;
      this.db.prepare(`
        UPDATE assignments SET status = 'queued', agent_id = NULL, claimed_at = NULL, completed_at = NULL,
          claim_token_hash = NULL, closed_reason = NULL, replaced_by_assignment_id = NULL, description = ?,
          target_agent_name = ?
        WHERE id = ?
      `).run(description, targetAgentName === undefined ? card.target_agent_name : (String(targetAgentName || "").trim() || null), assignmentId);
      const settled = this._settleResolvers(assignmentId, stamp, `${actor} reopened it`);
      this._event(taskId, agentId, "assignment.reopened", `${actor} reopened “${card.title}”${cleanNote ? `: ${cleanNote}` : "."}`, {
        assignmentId, previousStatus: card.status, note: cleanNote || null, settledResolvers: settled,
        ...(targetAgentName !== undefined ? { targetAgentName: String(targetAgentName || "").trim() || null } : {}),
      });
      if (card.verifies && (targetAgentName !== undefined)) this._releaseAuthorTargets(taskId);
      this._syncTaskStatus(taskId, stamp);
    });
    this._changed("assignment.reopened", taskId);
    return { reopened: true, taskId, assignmentId, title: card.title };
  },

  // Take a card off the board without pretending it was done. With a replacement, everything that
  // waited on this card waits on the replacement instead, and a review of it reviews the replacement.
  // Without one, the cards that waited on it simply stop waiting, and an open review of it is closed
  // with it — there is nothing left for that review to read.
  closeAssignment({ agentId = null, taskId, assignmentId, reason, replacedBy = null }) {
    this._assertMayChangeBoard(agentId, taskId);
    const card = this._boardCard(taskId, assignmentId);
    if (card.status === "claimed") throw new Error("Someone is working on this card. Ask them to stop first (cancel), then close it.");
    if (card.status === "done") throw new Error("This card is done; a finished card stays on the board as a record.");
    if (card.status === "closed") return { closed: true, alreadyClosed: true, taskId, assignmentId };
    const cleanReason = String(reason || "").trim().slice(0, 1000);
    if (!cleanReason) throw new Error("Say why this card is being closed.");
    const replacementId = replacedBy ? String(replacedBy).trim() : null;
    if (replacementId) {
      if (replacementId === assignmentId) throw new Error("A card cannot replace itself.");
      this._boardCard(taskId, replacementId);
      if (this._dependsTransitively(replacementId, assignmentId)) {
        throw new Error("The replacement waits on the card it replaces, so moving the arrows would make a loop.");
      }
    }
    const stamp = now();
    const actor = this._actorName(agentId);
    let moved = 0;
    let released = 0;
    let closedReviews = [];
    this._transaction(() => {
      this.db.prepare(`
        UPDATE assignments SET status = 'closed', completed_at = ?, claim_token_hash = NULL, closed_reason = ?,
          replaced_by_assignment_id = ?
        WHERE id = ?
      `).run(stamp, cleanReason, replacementId, assignmentId);
      const waiting = this.db.prepare("SELECT assignment_id FROM assignment_dependencies WHERE depends_on_assignment_id = ?").all(assignmentId);
      for (const { assignment_id: dependentId } of waiting) {
        this.db.prepare("DELETE FROM assignment_dependencies WHERE assignment_id = ? AND depends_on_assignment_id = ?").run(dependentId, assignmentId);
        if (replacementId && dependentId !== replacementId) {
          this.db.prepare("INSERT OR IGNORE INTO assignment_dependencies (assignment_id, depends_on_assignment_id) VALUES (?, ?)").run(dependentId, replacementId);
          moved += 1;
        } else {
          released += 1;
        }
      }
      const reviews = this.db.prepare(`
        SELECT id, title FROM assignments WHERE review_subject_assignment_id = ? AND status IN ('queued', 'blocked')
      `).all(assignmentId);
      for (const review of reviews) {
        if (replacementId) {
          this.db.prepare("UPDATE assignments SET review_subject_assignment_id = ? WHERE id = ?").run(replacementId, review.id);
        } else {
          this.db.prepare("UPDATE assignments SET status = 'closed', completed_at = ?, closed_reason = ? WHERE id = ?")
            .run(stamp, `The work it reviews was closed: ${cleanReason}`, review.id);
          this.db.prepare("DELETE FROM assignment_dependencies WHERE assignment_id = ?").run(review.id);
          // Whatever waited on the review waited on it passing; with nothing left to review, they stop waiting.
          released += this.db.prepare("DELETE FROM assignment_dependencies WHERE depends_on_assignment_id = ?").run(review.id).changes;
          closedReviews.push(review.title);
        }
      }
      const settled = this._settleResolvers(assignmentId, stamp, `${actor} closed it`);
      this._event(taskId, agentId, "assignment.closed",
        `${actor} closed “${card.title}”${replacementId ? `, replaced by “${this._boardCard(taskId, replacementId).title}”` : ""}: ${cleanReason}`, {
          assignmentId, previousStatus: card.status, reason: cleanReason, replacedBy: replacementId,
          movedDependents: moved, releasedDependents: released, closedReviews, settledResolvers: settled,
        });
      this._syncTaskStatus(taskId, stamp);
    });
    this._changed("assignment.closed", taskId);
    return { closed: true, taskId, assignmentId, replacedBy: replacementId, movedDependents: moved, releasedDependents: released, closedReviews };
  },

  _dependsTransitively(fromId, targetId) {
    const seen = new Set();
    const stack = [fromId];
    while (stack.length) {
      const current = stack.pop();
      if (current === targetId) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const row of this.db.prepare("SELECT depends_on_assignment_id FROM assignment_dependencies WHERE assignment_id = ?").all(current)) {
        stack.push(row.depends_on_assignment_id);
      }
    }
    return false;
  },

  // Change what a card says, who it is for, or what it waits on — for a card nobody holds yet.
  editAssignment({ agentId = null, taskId, assignmentId, title, description, targetAgentName, dependsOn }) {
    this._assertMayChangeBoard(agentId, taskId);
    const card = this._boardCard(taskId, assignmentId);
    if (!OPEN_FOR_EDIT.includes(card.status)) throw new Error(`Only a waiting or blocked card can be edited; this one is ${card.status}.`);
    const changes = {};
    if (title !== undefined) {
      const clean = String(title || "").trim().slice(0, 160);
      if (!clean) throw new Error("A card needs a title.");
      if (clean !== card.title) changes.title = clean;
    }
    if (description !== undefined) {
      const clean = String(description || "").trim().slice(0, 12000);
      if (!clean) throw new Error("A card needs a description.");
      if (clean !== card.description) changes.description = clean;
    }
    if (targetAgentName !== undefined) {
      const clean = String(targetAgentName || "").trim().slice(0, 80) || null;
      if (clean !== card.target_agent_name) changes.target_agent_name = clean;
    }
    let nextDependencies = null;
    if (dependsOn !== undefined) {
      nextDependencies = [...new Set((Array.isArray(dependsOn) ? dependsOn : []).map((id) => String(id).trim()).filter(Boolean))].slice(0, 50);
      for (const dependencyId of nextDependencies) {
        if (dependencyId === assignmentId) throw new Error("A card cannot wait on itself.");
        this._boardCard(taskId, dependencyId);
        if (this._dependsTransitively(dependencyId, assignmentId)) throw new Error("That dependency already waits on this card, so it would make a loop.");
      }
    }
    if (!Object.keys(changes).length && !nextDependencies) return { edited: false, taskId, assignmentId };
    const stamp = now();
    this._transaction(() => {
      for (const [column, value] of Object.entries(changes)) {
        this.db.prepare(`UPDATE assignments SET ${column} = ? WHERE id = ?`).run(value, assignmentId);
      }
      if (nextDependencies) {
        this.db.prepare("DELETE FROM assignment_dependencies WHERE assignment_id = ?").run(assignmentId);
        for (const dependencyId of nextDependencies) {
          this.db.prepare("INSERT INTO assignment_dependencies (assignment_id, depends_on_assignment_id) VALUES (?, ?)").run(assignmentId, dependencyId);
        }
      }
      this._event(taskId, agentId, "assignment.edited", `${this._actorName(agentId)} edited “${changes.title || card.title}”.`, {
        assignmentId,
        changed: [...Object.keys(changes).map((key) => (key === "target_agent_name" ? "targetAgentName" : key)), ...(nextDependencies ? ["dependsOn"] : [])],
        ...(changes.target_agent_name !== undefined ? { targetAgentName: changes.target_agent_name } : {}),
        ...(nextDependencies ? { dependsOn: nextDependencies } : {}),
      });
      if (card.verifies && changes.target_agent_name) this._releaseAuthorTargets(taskId);
      this._syncTaskStatus(taskId, stamp);
    });
    this._changed("assignment.edited", taskId);
    return { edited: true, taskId, assignmentId };
  },

  // The review comes back as its next round. When a reviewer sends work back, its review card is not
  // finished — it will read the fixed version — so the same card returns to the queue, waits for the
  // rework, and is addressed to the reviewer who asked. One card per piece of work, however many
  // rounds it takes, instead of "Review", "Re-review", "Final re-review" side by side.
  _rearmReview(review, { reviewerName = null, stamp }) {
    this.db.prepare(`
      UPDATE assignments SET status = 'queued', agent_id = NULL, claimed_at = NULL, completed_at = NULL,
        claim_token_hash = NULL, review_round = review_round + 1,
        target_agent_name = COALESCE(?, target_agent_name)
      WHERE id = ?
    `).run(reviewerName, review.id);
    if (review.review_subject_assignment_id) {
      this.db.prepare("INSERT OR IGNORE INTO assignment_dependencies (assignment_id, depends_on_assignment_id) VALUES (?, ?)")
        .run(review.id, review.review_subject_assignment_id);
    }
    const round = Number(review.review_round || 1) + 1;
    this._event(review.task_id, null, "assignment.review_round",
      `“${review.title}” comes back as round ${round} once the changes are made.`,
      { assignmentId: review.id, round, subjectAssignmentId: review.review_subject_assignment_id || null });
    return round;
  },

  // Called when work is sent back: the latest finished review of that work goes round again. A review
  // still being held is left alone here and re-armed when its holder reports it (see completeAssignment).
  _rearmReviewOf(subjectId, { reviewerAgentId = null, stamp }) {
    const review = this.db.prepare(`
      SELECT * FROM assignments
      WHERE review_subject_assignment_id = ? AND verifies = 1 AND status = 'done'
      ORDER BY completed_at DESC LIMIT 1
    `).get(subjectId);
    if (!review) return null;
    const reviewerName = reviewerAgentId ? this.getAgent(reviewerAgentId).name : null;
    return { assignmentId: review.id, round: this._rearmReview(review, { reviewerName, stamp }) };
  },

  // A reviewer may send work back while still holding its review, and report afterwards. Then the
  // review has to go round again the moment it is reported, or the fix would never be re-read.
  _rearmIfSubjectSentBack(review, { reviewerName, stamp }) {
    if (!review.verifies || !review.review_subject_assignment_id) return null;
    const subject = this.db.prepare("SELECT status, rework_requested_at FROM assignments WHERE id = ?").get(review.review_subject_assignment_id);
    if (!subject?.rework_requested_at || subject.status === "done") return null;
    if (review.claimed_at && subject.rework_requested_at < review.claimed_at) return null;
    const fresh = this.db.prepare("SELECT * FROM assignments WHERE id = ?").get(review.id);
    return this._rearmReview(fresh, { reviewerName, stamp });
  },

  // A whole plan in one call. Each card may name the cards it waits on by their `key` in this batch
  // as well as by existing id, which is what lets a planner declare the real order before any of the
  // ids exist — 51% of Stuff Downloader's cards recorded no dependency at all, and the board could
  // only guess their shape from creation times.
  planBatch({ agentId = null, taskId, cards }) {
    if (!Array.isArray(cards) || !cards.length) throw new Error("cards needs at least one card.");
    if (cards.length > MAX_BATCH) throw new Error(`Plan at most ${MAX_BATCH} cards in one call.`);
    // Checked before anything is created, so a bad card does not leave half a plan on the board.
    for (const [index, card] of cards.entries()) {
      if (!String(card?.title ?? "").trim() || !String(card?.description ?? "").trim()) {
        throw new Error(`Card ${index + 1} needs a title and a description.`);
      }
    }
    const keys = new Map();
    for (const [index, card] of cards.entries()) {
      const key = String(card?.key ?? "").trim();
      if (key) {
        if (keys.has(key)) throw new Error(`Two cards use the key "${key}".`);
        keys.set(key, index);
      }
    }
    // References must point backwards in the batch, which is also what rules out a loop inside it.
    const resolveRef = (ref, index, created) => {
      const clean = String(ref).trim();
      if (keys.has(clean)) {
        const at = keys.get(clean);
        if (at >= index) throw new Error(`Card ${index + 1} refers to "${clean}", which comes later in the plan; list cards in the order they happen.`);
        return created[at].id;
      }
      return clean;
    };
    const created = [];
    for (const [index, card] of cards.entries()) {
      const result = this.createAssignment({
        agentId, taskId,
        title: card.title, description: card.description, role: card.role, requiresWrite: card.requiresWrite,
        targetAgentName: card.targetAgentName, checklist: card.checklist, paths: card.paths, domains: card.domains,
        dependsOn: (card.dependsOn || []).map((ref) => resolveRef(ref, index, created)),
        reviewSubjectAssignmentId: card.reviews ? resolveRef(card.reviews, index, created) : card.reviewSubjectAssignmentId,
      });
      created.push(result);
    }
    return {
      created: created.map((card, index) => ({ key: cards[index].key || null, id: card.id, title: card.title, role: card.role, duplicateOf: card.duplicateOf || null })),
    };
  },
};
