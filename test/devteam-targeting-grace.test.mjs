import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore, TARGET_RECONNECT_GRACE_MS } from "../src/devteam/store.mjs";

// Some hosts open a fresh MCP session every turn. Between the old transport closing and the new
// session joining there are a few seconds with nobody by that name connected, and on 2026-09-15 a
// critique targeted at Codex was claimed by its own author inside exactly that gap. A dropped
// transport is a reconnect in progress; a deliberate leave is not.

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-grace-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Grace project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Grace", description: "Reconnects are not handoffs.", requiredApprovals: 1 });
  return { store, task };
}

// Move a disconnect into the past, as if the grace window had already run.
const age = (store, agentId, ms) => store.db.prepare("UPDATE agents SET disconnected_at = ? WHERE id = ?")
  .run(new Date(Date.now() - ms).toISOString(), agentId);

async function targetedAtCodex(t) {
  const { store, task } = await fixture(t);
  const codex = store.connectAgent({ name: "Codex", provider: "fixture", freshTaskId: task.id });
  const claude = store.connectAgent({ name: "Claude", provider: "fixture", freshTaskId: task.id });
  const plan = store.claimNextAssignment(claude.id);
  const targeted = store.createAssignment({ taskId: task.id, title: "Critique", description: "For Codex.", role: "researcher", targetAgentName: "Codex" });
  await store.completeAssignment({ agentId: claude.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  return { store, task, codex, claude, targeted };
}

test("a target whose transport just dropped keeps its hold on targeted work", async (t) => {
  const { store, codex, claude, targeted } = await targetedAtCodex(t);
  store.handleTransportClose(codex.id);

  assert.equal(store.claimNextAssignment(claude.id), null, "a reconnecting target is not an absent one");
  const why = store.whyNotClaimable(targeted.id, claude.id);
  assert.ok(why.reasons.some((reason) => reason.code === "targeted_elsewhere"), "the explanation agrees with the scan");
  assert.ok(!why.reasons.some((reason) => reason.code === "target_absent"), "and does not call the target absent");
});

test("the returning target claims its work under its new session", async (t) => {
  const { store, task, codex, targeted } = await targetedAtCodex(t);
  store.handleTransportClose(codex.id);
  const codexAgain = store.connectAgent({ name: "Codex", provider: "fixture", freshTaskId: task.id });
  assert.equal(store.claimNextAssignment(codexAgain.id)?.id, targeted.id);
});

test("once the grace window has passed, targeted work returns to the room as before", async (t) => {
  const { store, codex, claude, targeted } = await targetedAtCodex(t);
  store.handleTransportClose(codex.id);
  age(store, codex.id, TARGET_RECONNECT_GRACE_MS + 1_000);

  assert.equal(store.claimNextAssignment(claude.id)?.id, targeted.id, "a target that never came back does not strand the work");
});

test("a deliberate leave releases targeted work immediately, with no grace", async (t) => {
  const { store, codex, claude, targeted } = await targetedAtCodex(t);
  store.disconnectAgent(codex.id, "Done for the day.");
  assert.equal(store.claimNextAssignment(claude.id)?.id, targeted.id);
});

async function authorWithReviewer(t) {
  const { store, task } = await fixture(t);
  const planner = store.connectAgent({ name: "Planner", provider: "fixture", freshTaskId: task.id });
  const alice = store.connectAgent({ name: "Alice", provider: "fixture", freshTaskId: task.id });
  const bob = store.connectAgent({ name: "Bob", provider: "fixture", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Build", description: "Implement it.", role: "implementer", requiresWrite: true, targetAgentName: "Alice" });
  const review = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Review", description: "Review it.", role: "reviewer" });
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  store.disconnectAgent(planner.id, "Planned and left.");
  const build = store.claimNextAssignment(alice.id);
  await store.completeAssignment({ agentId: alice.id, assignmentId: build.id, claimToken: build.claimToken, message: "Built.", changedFiles: ["package.json"] });
  return { store, task, alice, bob, review };
}

test("the author is not handed its own review while the independent reviewer is reconnecting", async (t) => {
  const { store, task, alice, bob, review } = await authorWithReviewer(t);
  store.handleTransportClose(bob.id);

  assert.equal(store.claimNextAssignment(alice.id), null, "Bob is on his way back, so Alice waits");

  const bobAgain = store.connectAgent({ name: "Bob", provider: "fixture", freshTaskId: task.id });
  assert.equal(store.claimNextAssignment(bobAgain.id)?.id, review.id, "and the review goes to the independent reviewer");
});

test("with solo mode on, after the grace window the author may self-review, so the review never strands", async (t) => {
  const { store, task, alice, bob, review } = await authorWithReviewer(t);
  store.updateProject(task.project_id, { soloReview: true });
  store.handleTransportClose(bob.id);
  age(store, bob.id, TARGET_RECONNECT_GRACE_MS + 1_000);

  assert.equal(store.claimNextAssignment(alice.id)?.id, review.id);
});

test("with solo mode on, a deliberate leave by the reviewer hands the author the review immediately, as before", async (t) => {
  const { store, task, alice, bob, review } = await authorWithReviewer(t);
  store.updateProject(task.project_id, { soloReview: true });
  store.disconnectAgent(bob.id, "Going home.");
  assert.equal(store.claimNextAssignment(alice.id)?.id, review.id);
});

test("a review subject keeps its author out after a later task version", async (t) => {
  const { store, task, alice, bob } = await authorWithReviewer(t);
  const originalReview = store.claimNextAssignment(bob.id);
  await store.completeAssignment({ agentId: bob.id, assignmentId: originalReview.id, claimToken: originalReview.claimToken, message: "Reviewed." });
  // Simulate an unrelated later edit by another assignment; the review still concerns Alice's build.
  store.db.prepare("UPDATE tasks SET version = version + 1 WHERE id = ?").run(task.id);
  const build = store.db.prepare("SELECT id FROM assignments WHERE task_id = ? AND title = 'Build'").get(task.id);
  const review = store.createAssignment({ taskId: task.id, title: "Security review of Build", description: "Review Alice's build.", role: "security-reviewer", reviewSubjectAssignmentId: build.id });
  assert.equal(review.review_subject_assignment_id, build.id);
  assert.equal(store.claimNextAssignment(alice.id), null, "the original author cannot claim its explicitly scoped review");
  assert.equal(store.claimNextAssignment(bob.id)?.id, review.id, "an independent teammate can claim it");
});

test("the disconnect kind column is added idempotently to an existing database", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-grace-migrate-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const first = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  first.close();
  const second = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  const columns = second.db.prepare("PRAGMA table_info(agents)").all().map((column) => column.name);
  second.close();
  assert.equal(columns.filter((name) => name === "disconnect_kind").length, 1);
});
