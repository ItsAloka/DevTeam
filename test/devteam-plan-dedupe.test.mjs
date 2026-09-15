import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";

test("one open verifying assignment per role avoids duplicate reviews without blocking new work", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-plan-dedupe-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-plan-dedupe-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); await rm(projectRoot, { recursive: true, force: true }); });

  const project = store.ensureProject("Review dedupe", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Review once", description: "Avoid duplicate review work." });
  const planner = store.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  const writer = store.connectAgent({ name: "Writer", provider: "test", freshTaskId: task.id });
  const reviewer = store.connectAgent({ name: "Reviewer", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);

  const firstReview = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Correctness review", description: "Review the result.", role: "reviewer", targetAgentName: "Reviewer" });
  const duplicateReview = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Correctness review", description: "This must reuse the open review.", role: "reviewer" });
  assert.equal(duplicateReview.id, firstReview.id);
  assert.equal(duplicateReview.duplicateOf, firstReview.id);
  assert.equal(store.taskDetail(task.id).assignments.filter((assignment) => assignment.verifies && assignment.role === "reviewer" && assignment.status === "queued").length, 1);

  const securityReview = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Security review", description: "Review security.", role: "security-reviewer" });
  assert.notEqual(securityReview.id, firstReview.id, "different verifying roles remain independent assignments");
  const firstImplementation = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Implement first part", description: "Write source.", role: "implementer", requiresWrite: true, targetAgentName: "Writer", paths: ["src/one.mjs"] });
  const secondImplementation = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Implement second part", description: "Write another source.", role: "implementer", requiresWrite: true, paths: ["src/two.mjs"] });
  assert.notEqual(secondImplementation.id, firstImplementation.id, "parallel implementation work is unaffected");

  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  const work = store.claimNextAssignment(writer.id);
  assert.equal(work.id, firstImplementation.id);
  await store.completeAssignment({ agentId: writer.id, assignmentId: work.id, claimToken: work.claimToken, message: "Implemented.", changedFiles: ["src/one.mjs"] });
  const secondWork = store.claimNextAssignment(writer.id);
  assert.equal(secondWork.id, secondImplementation.id);
  await store.completeAssignment({ agentId: writer.id, assignmentId: secondWork.id, claimToken: secondWork.claimToken, message: "Implemented the second part.", changedFiles: ["src/two.mjs"] });
  const claimedReview = store.claimNextAssignment(reviewer.id);
  assert.equal(claimedReview.id, firstReview.id);
  await store.completeAssignment({ agentId: reviewer.id, assignmentId: claimedReview.id, claimToken: claimedReview.claimToken, message: "Reviewed." });

  const nextVersionReview = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Correctness review after change", description: "Review the new version.", role: "reviewer" });
  assert.notEqual(nextVersionReview.id, firstReview.id, "a completed review never suppresses review of a new task version");
});

async function dedupeFixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-plan-dedupe-v-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Dedupe versions", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Later versions", description: "Dedupe past v1." });
  return { store, task };
}

test("dedupe still works once the task is past version 1", async (t) => {
  const { store, task } = await dedupeFixture(t);
  store.db.prepare("UPDATE tasks SET version = 7 WHERE id = ?").run(task.id);
  const first = store.createAssignment({ taskId: task.id, title: "Review it", description: "Review.", role: "reviewer" });
  const second = store.createAssignment({ taskId: task.id, title: "Review it", description: "Again.", role: "reviewer" });
  assert.equal(second.duplicateOf, first.id, "an identical open review at v7 is reused, not duplicated");
  assert.match(second.message, /reusing/);
});

test("reviews of different subjects or titles, or for a different named reviewer, are not collapsed", async (t) => {
  const { store, task } = await dedupeFixture(t);
  const base = store.createAssignment({ taskId: task.id, title: "Review it", description: "Review.", role: "reviewer", targetAgentName: "Codex" });
  const otherTitle = store.createAssignment({ taskId: task.id, title: "Review the plan doc", description: "Review.", role: "reviewer" });
  assert.equal(otherTitle.duplicateOf, undefined);
  const otherTarget = store.createAssignment({ taskId: task.id, title: "Review it", description: "Review.", role: "reviewer", targetAgentName: "Claude" });
  assert.equal(otherTarget.duplicateOf, undefined, "a request for a different independent reviewer is honoured");
  const sameTarget = store.createAssignment({ taskId: task.id, title: "Review it", description: "Review.", role: "reviewer", targetAgentName: "codex" });
  assert.equal(sameTarget.duplicateOf, base.id, "the same target, case-insensitively, is a real duplicate");
});
