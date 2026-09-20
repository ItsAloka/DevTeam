// Reported checks, check baselines and regression detection: the part of DevTeamStore that answers
// "what has this task's suite been doing", as opposed to "who does this work go to".
//
// DevTeam used to run checks itself. A human allowlisted commands per project, an agent named one in
// its report, and DevTeam spawned it in the project root and graded it by exit code. That machinery
// — executor, argv allowlist, Node permission sandbox, the off-event-loop verifying window and its
// durable job row — is gone. It was off by default and stayed off, which meant the distinction it
// bought (verified vs. asserted) was never true in practice, while every path in this file had to
// carry it. What remains is the part that earned its keep: noticing that a check which used to pass
// now fails, and routing a fix to whoever plausibly broke it.
//
// So a check is now the agent's word: a label plus, optionally, a status it reports. That is weaker
// evidence and the code says so plainly rather than dressing it up.
//
// Composed onto DevTeamStore.prototype as a mixin rather than held as a collaborator object. These
// methods call the store's own internals constantly, and a collaborator would have had to be handed
// every one of them. As a mixin, `this` is still the store and no call site changed. The price is
// that the internals they reach for cannot be #private; see the note on _transaction in store.mjs.
import { randomUUID } from "node:crypto";
import { fromJson, json, now } from "./util.mjs";

// How many checks one report may carry. A report listing a hundred lines is not evidence, it is a
// log, and the timeline is not where a log belongs.
export const CHECKS_PER_REPORT = 100;

export const checksMethods = {
  // What a report claimed. Every record is the agent's assertion — there is no other kind now — so
  // nothing here needs a flag distinguishing the two.
  _checksFor(assignmentId) {
    return this.db.prepare(`
      SELECT label, status, created_at
      FROM assignment_checks WHERE assignment_id = ? AND superseded_at IS NULL
      ORDER BY created_at ASC, rowid ASC
    `).all(assignmentId).map((row) => ({
      label: row.label,
      status: row.status,
      createdAt: row.created_at,
    }));
  },

  // Normalize what an agent reported. A check is a plain string — a bare assertion, no claim either
  // way about the outcome — or { label, status } where status is the result the agent is reporting.
  // An unrecognized status is recorded as a bare assertion rather than being guessed into a result:
  // inventing "passed" from a typo is exactly how an unearned green mark gets onto the board.
  _normalizeReportedChecks(checks) {
    const records = [];
    for (const item of Array.isArray(checks) ? checks.slice(0, CHECKS_PER_REPORT) : []) {
      const isObject = item && typeof item === "object" && !Array.isArray(item);
      const label = String((isObject ? item.label : item) ?? "").trim();
      if (!label) continue;
      const reported = isObject ? String(item.status ?? "").trim().toLowerCase() : "";
      records.push({
        label: label.slice(0, 500),
        status: ["passed", "failed"].includes(reported) ? reported : "asserted",
      });
    }
    return records;
  },

  // T2.3 — regression awareness.
  //
  // Nothing in DevTeam used to notice that agent B broke what agent A delivered. A team that cannot
  // see that cannot cover for each other; it is just several agents in one room.
  //
  // The comparison is per task, per check. The key used to be the argv DevTeam ran, which made two
  // agents describing the same suite differently still compare against one baseline. Without an
  // executor the only stable handle left is the label itself, normalized for case and spacing — so
  // "npm test" and "NPM  test" compare, and "ran the test suite" is a different check. That is a
  // real loss of precision and the honest way to state it is in a comment, not in a heuristic that
  // guesses which prose means which suite.
  _checkKey(record) {
    const key = String(record.label ?? "").trim().toLowerCase().replace(/\s+/gu, " ");
    return key || null;
  },

  // Who plausibly broke it. Not "the agent that reported the failure" — that agent is usually the one
  // who *found* it — but whoever changed files between the last time this check passed and now.
  // Deliberately a list: with more than one writer in that window, naming one would be a guess
  // dressed up as a finding, so the honest answer is the set and its size.
  _regressionSuspects(taskId, sinceEventId, excludeAssignmentIds) {
    const excluded = new Set([excludeAssignmentIds].flat().filter(Boolean));
    const rows = this.db.prepare(`
      SELECT e.metadata, e.agent_id, e.author_name, e.created_at
      FROM events e
      WHERE e.task_id = ? AND e.type = 'assignment.completed' AND e.id > ?
      ORDER BY e.id ASC
    `).all(taskId, Number(sinceEventId) || 0);
    const suspects = new Map();
    for (const row of rows) {
      const metadata = fromJson(row.metadata, {});
      const changed = Array.isArray(metadata.changedFiles) ? metadata.changedFiles : [];
      if (!changed.length) continue;                          // a read-only report changed nothing
      // Neither the report that surfaced the failure nor the one that last made this check green.
      // The mark is taken before a passing report writes its own completion event, so without the
      // second exclusion the assignment that fixed a check becomes a suspect for breaking it.
      if (excluded.has(metadata.assignmentId)) continue;
      const assignment = this.db.prepare("SELECT title FROM assignments WHERE id = ?").get(metadata.assignmentId);
      if (!assignment) continue;
      suspects.set(metadata.assignmentId, {
        assignmentId: metadata.assignmentId,
        title: assignment.title,
        author: row.author_name || null,
        authorAgentId: row.agent_id || null,
        changedFiles: changed.slice(0, 20),
        completedAt: row.created_at,
      });
    }
    return [...suspects.values()];
  },

  // Compare this report's checks against the task's baseline, record the new baseline, and return
  // whatever regressed. Called on both report paths — a refused report is still evidence, and is in
  // fact the path on which a regression is most often first seen.
  _recordCheckBaselines({ taskId, assignmentId, records, version, stamp }) {
    const regressions = [];
    for (const record of records) {
      // A bare assertion states no outcome, so it can neither establish a baseline nor quietly
      // repair one. Only a reported pass or fail moves anything.
      if (!["passed", "failed"].includes(record.status)) continue;
      const checkKey = this._checkKey(record);
      if (!checkKey) continue;
      const previous = this.db.prepare("SELECT * FROM check_baselines WHERE task_id = ? AND check_key = ?").get(taskId, checkKey);
      const regressed = previous?.status === "passed" && record.status === "failed";
      if (regressed) {
        const suspects = this._regressionSuspects(taskId, previous.last_passed_event_id,
          [assignmentId, previous.last_passed_assignment_id]);
        regressions.push({
          id: randomUUID(),
          checkKey,
          label: record.label,
          lastPassedAt: previous.last_passed_at || previous.updated_at,
          lastPassedAssignmentId: previous.last_passed_assignment_id || previous.assignment_id || null,
          suspects,
        });
      }
      // Where the timeline stands right now. Captured before this report writes its own completion
      // event, so the mark never includes the report that set it.
      const timelineMark = Number(this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE task_id = ?").get(taskId).id) || 0;
      this.db.prepare(`
        INSERT INTO check_baselines (task_id, check_key, status, label, assignment_id, task_version, last_passed_at, last_passed_assignment_id, last_passed_event_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, check_key) DO UPDATE SET
          status = excluded.status, label = excluded.label, assignment_id = excluded.assignment_id,
          task_version = excluded.task_version, updated_at = excluded.updated_at,
          -- Only a pass moves the "last green" mark. Keeping it pinned is what lets the *next*
          -- failure still name the whole window of changes since things actually worked.
          last_passed_at = CASE WHEN excluded.status = 'passed' THEN excluded.updated_at ELSE check_baselines.last_passed_at END,
          last_passed_assignment_id = CASE WHEN excluded.status = 'passed' THEN excluded.assignment_id ELSE check_baselines.last_passed_assignment_id END,
          last_passed_event_id = CASE WHEN excluded.status = 'passed' THEN excluded.last_passed_event_id ELSE check_baselines.last_passed_event_id END
      `).run(taskId, checkKey, record.status, record.label, assignmentId, Number(version) || 1,
        record.status === "passed" ? stamp : (previous?.last_passed_at || null),
        record.status === "passed" ? assignmentId : (previous?.last_passed_assignment_id || null),
        record.status === "passed" ? timelineMark : (previous?.last_passed_event_id || 0),
        stamp);
      // A check going green again closes whatever it broke, so the board does not accumulate
      // regressions that were quietly fixed by ordinary work.
      if (record.status === "passed") {
        this.db.prepare("UPDATE check_regressions SET resolved_at = ? WHERE task_id = ? AND check_key = ? AND resolved_at IS NULL")
          .run(stamp, taskId, checkKey);
      }
    }
    return regressions;
  },

  // Record the regressions and, where the breakage is attributable to work *other* than the report
  // that surfaced it, route a fix back to whoever did it. This is the mechanism that turns a group of
  // agents into a team that covers for each other: the agent that tripped over the breakage is told
  // it is not theirs to chase, and the agent that caused it is handed the work.
  _openRegressions({ taskId, assignmentId, regressions, stamp, projectId }) {
    const opened = [];
    for (const regression of regressions) {
      // One open fix per broken check. Without this, every subsequent report that names the same
      // failing suite would queue another near-identical assignment.
      const existing = this.db.prepare(`
        SELECT fix_assignment_id FROM check_regressions
        WHERE task_id = ? AND check_key = ? AND resolved_at IS NULL AND fix_assignment_id IS NOT NULL LIMIT 1
      `).get(taskId, regression.checkKey);
      let fixAssignmentId = null;
      const soleSuspect = regression.suspects.length === 1 ? regression.suspects[0] : null;
      if (!existing && regression.suspects.length) {
        fixAssignmentId = randomUUID();
        const behaviour = this.roleBehaviour("implementer");
        const suspectSummary = soleSuspect
          ? `“${soleSuspect.title}”${soleSuspect.author ? ` (${soleSuspect.author})` : ""}`
          : `${regression.suspects.length} pieces of work`;
        this.db.prepare(`
          INSERT INTO assignments (id, task_id, title, description, role, requires_write, target_agent_name, status, created_at, verifies, plans)
          VALUES (?, ?, ?, ?, ?, 1, ?, 'queued', ?, ?, ?)
        `).run(
          fixAssignmentId, taskId,
          `Fix the regression in “${regression.label}”`,
          [
            `The check “${regression.label}” was reported as passing before and is now reported as failing.`,
            `It was last green before ${suspectSummary} landed.`,
            regression.suspects.length === 1
              ? `Changed files: ${soleSuspect.changedFiles.join(", ")}.`
              : `Changed files across that window: ${[...new Set(regression.suspects.flatMap((suspect) => suspect.changedFiles))].slice(0, 20).join(", ")}.`,
            regression.suspects.length > 1
              ? "More than one piece of work landed in that window, so this attribution is a starting point, not a verdict — check before assuming."
              : "",
            "Restore the check to passing without reverting unrelated work.",
          ].filter(Boolean).join(" "),
          "implementer", soleSuspect?.author || null, stamp,
          behaviour.verifies ? 1 : 0, behaviour.plans ? 1 : 0,
        );
        // Scope the fix to the files the suspects actually touched. Left unscoped it would take a
        // whole-project lease and block every unrelated writer in the room — a regression fix that
        // stops the rest of the team is a worse outcome than the regression.
        const scope = [...new Set(regression.suspects.flatMap((suspect) => suspect.changedFiles))].slice(0, 50);
        if (scope.length) {
          this.db.prepare("INSERT OR REPLACE INTO assignment_write_scopes (assignment_id, paths) VALUES (?, ?)")
            .run(fixAssignmentId, json(scope));
        }
        this._event(taskId, null, "assignment.created", `Fix the regression in “${regression.label}”`, {
          assignmentId: fixAssignmentId, role: "implementer", requiresWrite: true,
          targetAgentName: soleSuspect?.author || null, regressionOf: regression.checkKey, writePaths: scope,
        });
      }
      this.db.prepare(`
        INSERT INTO check_regressions (id, task_id, check_key, label, detected_by_assignment_id, last_passed_assignment_id, suspects, fix_assignment_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(regression.id, taskId, regression.checkKey, regression.label, assignmentId,
        regression.lastPassedAssignmentId, json(regression.suspects), fixAssignmentId, stamp);
      this._event(taskId, null, "check.regressed",
        `“${regression.label}” was reported passing before and is now reported failing${soleSuspect ? `, first failing after “${soleSuspect.title}”` : ""}.`, {
          label: regression.label,
          suspects: regression.suspects.map((suspect) => ({ assignmentId: suspect.assignmentId, title: suspect.title, author: suspect.author })),
          fixAssignmentId,
          detectedByAssignmentId: assignmentId,
        });
      opened.push({
        id: regression.id,
        label: regression.label,
        lastPassedAt: regression.lastPassedAt,
        suspects: regression.suspects.map((suspect) => ({ assignmentId: suspect.assignmentId, title: suspect.title, author: suspect.author, changedFiles: suspect.changedFiles })),
        fixAssignmentId,
        attribution: regression.suspects.length === 1 ? "single" : (regression.suspects.length ? "ambiguous" : "unattributed"),
      });
    }
    return opened;
  },

  // Open regressions for a task, for the dashboard and for an agent asking what is currently broken.
  openRegressions(taskId) {
    return this.db.prepare(`
      SELECT id, check_key, label, detected_by_assignment_id, suspects, fix_assignment_id, created_at
      FROM check_regressions WHERE task_id = ? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 20
    `).all(taskId).map((row) => ({
      id: row.id,
      label: row.label,
      detectedByAssignmentId: row.detected_by_assignment_id,
      suspects: fromJson(row.suspects, []),
      fixAssignmentId: row.fix_assignment_id,
      createdAt: row.created_at,
    }));
  },

  // The check baseline for a task: what each check was last reported to do, and when it was last
  // green.
  checkBaseline(taskId) {
    return this.db.prepare(`
      SELECT check_key, status, label, task_version, last_passed_at, updated_at
      FROM check_baselines WHERE task_id = ? ORDER BY label ASC
    `).all(taskId).map((row) => ({
      label: row.label,
      status: row.status,
      taskVersion: row.task_version,
      lastPassedAt: row.last_passed_at,
      updatedAt: row.updated_at,
    }));
  },

  _storeReportedChecks(assignmentId, taskId, records, stamp) {
    // A rejected report leaves the claim intact so the agent can fix the work and report again, so
    // an assignment accumulates one batch per attempt. Only the latest attempt describes the work as
    // it now stands: without this, an assignment that reported a failing check and then a passing one
    // would go on showing the failure forever, and "did a check fail here?" would answer yes about
    // work that is green. Earlier attempts are kept, marked superseded, so the history is on record.
    this.db.prepare("UPDATE assignment_checks SET superseded_at = ? WHERE assignment_id = ? AND superseded_at IS NULL")
      .run(stamp, assignmentId);
    for (const record of records) {
      this.db.prepare(`
        INSERT INTO assignment_checks (id, assignment_id, task_id, label, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), assignmentId, taskId, record.label, record.status, stamp);
    }
  },
};
