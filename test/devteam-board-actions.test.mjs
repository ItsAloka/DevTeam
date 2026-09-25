import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";
import { startDevTeamServer } from "../src/devteam/server.mjs";

// Fixing a card instead of copying it. Rebuild 9 ended with 21 cards for three pieces of work: a
// blocked review that could never finish, a chain of cards stuck behind it, a replacement for each,
// and a new card for every re-review. These pin down the moves that make those copies unnecessary.

async function fixture(t, { team } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-board-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Board project", process.cwd());
  if (team) store.updateProject(project.id, { team });
  const task = store.createTask({ projectId: project.id, title: "Rebuild", description: "Plan, build, review.", requiredApprovals: 1 });
  return { store, project, task };
}

const card = (store, id) => store.db.prepare("SELECT * FROM assignments WHERE id = ?").get(id);
const dependenciesOf = (store, id) => store.db.prepare("SELECT depends_on_assignment_id AS id FROM assignment_dependencies WHERE assignment_id = ? ORDER BY id").all(id).map((row) => row.id);
const report = (store, agent, claim, extra = {}) => store.completeAssignment({ agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken, message: "Reported.", ...extra });

// Codex plans build → review → next build; Codex then leaves so Claude can work.
async function plannedChain(t, options) {
  const { store, project, task } = await fixture(t, options);
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI Codex", freshTaskId: task.id });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic Claude Code", freshTaskId: task.id });
  const plan = store.claimNextAssignment(codex.id);
  const { created } = store.planBatch({
    agentId: codex.id, taskId: task.id, cards: [
      { key: "build", title: "Build discovery", description: "Implement it.", role: "implementer", requiresWrite: true, paths: ["a/**"], targetAgentName: "Claude" },
      { key: "review", title: "Review discovery", description: "Review it.", role: "reviewer", reviews: "build", dependsOn: ["build"], targetAgentName: "Codex" },
      { key: "next", title: "Build installer", description: "Next step.", role: "implementer", requiresWrite: true, paths: ["b/**"], dependsOn: ["review"], targetAgentName: "Claude" },
    ],
  });
  await report(store, codex, plan);
  const ids = Object.fromEntries(created.map((item) => [item.key, item.id]));
  return { store, project, task, codex, claude, ids };
}

test("a whole plan goes on the board in one call, with its real order", async (t) => {
  const { store, ids } = await plannedChain(t);
  assert.deepEqual(dependenciesOf(store, ids.review), [ids.build]);
  assert.deepEqual(dependenciesOf(store, ids.next), [ids.review]);
  assert.equal(card(store, ids.review).review_subject_assignment_id, ids.build);
});

test("a plan batch refuses forward references and bad cards before creating anything", async (t) => {
  const { store, task } = await fixture(t);
  const before = store.db.prepare("SELECT COUNT(*) AS count FROM assignments").get().count;
  assert.throws(() => store.planBatch({ taskId: task.id, cards: [
    { key: "a", title: "A", description: "First.", dependsOn: ["b"] },
    { key: "b", title: "B", description: "Second." },
  ] }), /comes later in the plan/);
  assert.throws(() => store.planBatch({ taskId: task.id, cards: [
    { title: "Fine", description: "Fine." },
    { title: "", description: "Missing title." },
  ] }), /Card 2 needs a title/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM assignments").get().count, before, "nothing half-created");
});

test("sending work back brings the same review card round again instead of a new one", async (t) => {
  const { store, task, codex, claude, ids } = await plannedChain(t);
  const build = store.claimNextAssignment(claude.id);
  assert.equal(build.id, ids.build);
  await report(store, claude, build, { changedFiles: ["package.json"] });

  const review = store.claimNextAssignment(codex.id);
  assert.equal(review.id, ids.review);
  await report(store, codex, review);
  const sentBack = store.requestChanges({ agentId: codex.id, taskId: task.id, assignmentId: ids.build, summary: "One case is missing.", findings: ["Reject [null]."] });
  assert.equal(sentBack.reviewRound, 2);

  const rearmed = card(store, ids.review);
  assert.equal(rearmed.status, "queued");
  assert.equal(rearmed.review_round, 2);
  assert.equal(rearmed.target_agent_name, "Codex", "the reviewer who asked reads the fix");
  assert.equal(store.claimNextAssignment(codex.id), null, "and it waits for the rework");

  const rework = store.claimNextAssignment(claude.id);
  assert.equal(rework.id, ids.build);
  await report(store, claude, rework, { changedFiles: ["package.json"] });
  const second = store.claimNextAssignment(codex.id);
  assert.equal(second.id, ids.review, "round 2 is the same card");
  await report(store, codex, second);
  const approval = store.approveTask({ agentId: codex.id, taskId: task.id, summary: "Fixed." });
  assert.equal(approval.approvalCount, 1);
  const reviewCards = store.db.prepare("SELECT COUNT(*) AS count FROM assignments WHERE task_id = ? AND verifies = 1").get(task.id).count;
  assert.equal(reviewCards, 1, "one review card for one piece of work");
});

test("a reviewer that sends work back before reporting still gets the next round", async (t) => {
  const { store, task, codex, claude, ids } = await plannedChain(t);
  const build = store.claimNextAssignment(claude.id);
  await report(store, claude, build, { changedFiles: ["package.json"] });
  const review = store.claimNextAssignment(codex.id);
  store.requestChanges({ agentId: codex.id, taskId: task.id, assignmentId: ids.build, summary: "Not yet." });
  await report(store, codex, review);
  const after = card(store, ids.review);
  assert.equal(after.status, "queued");
  assert.equal(after.review_round, 2);
});

test("a blocked card is reopened, its planner card settles, and what waited on it still waits on it", async (t) => {
  const { store, task, codex, claude, ids } = await plannedChain(t);
  const build = store.claimNextAssignment(claude.id);
  const blocked = await report(store, claude, build, { status: "blocked", message: "The spec is missing the version rules." });
  const resolver = card(store, blocked.followUpAssignmentId);
  assert.equal(resolver.resolves_assignment_id, ids.build);

  store.reopenAssignment({ agentId: codex.id, taskId: task.id, assignmentId: ids.build, note: "Use PEP 440 and skip pre-releases." });
  const reopened = card(store, ids.build);
  assert.equal(reopened.status, "queued");
  assert.match(reopened.description, /Reopened by Codex: Use PEP 440/);
  assert.equal(card(store, resolver.id).status, "closed", "the planner card it queued has nothing left to decide");
  assert.deepEqual(dependenciesOf(store, ids.review), [ids.build], "the review still reviews the same card");
  assert.equal(store.claimNextAssignment(claude.id)?.id, ids.build);
});

test("closing a card with a replacement moves its waiters and its review to the replacement", async (t) => {
  const { store, task, codex, ids } = await plannedChain(t);
  const replacement = store.createAssignment({ agentId: codex.id, taskId: task.id, title: "Build discovery, smaller", description: "Rescoped.", role: "implementer", requiresWrite: true, paths: ["a/**"] });
  const result = store.closeAssignment({ agentId: codex.id, taskId: task.id, assignmentId: ids.build, reason: "Rescoped.", replacedBy: replacement.id });
  assert.equal(result.movedDependents, 1);
  assert.equal(card(store, ids.build).status, "closed");
  assert.equal(card(store, ids.build).replaced_by_assignment_id, replacement.id);
  assert.deepEqual(dependenciesOf(store, ids.review), [replacement.id]);
  assert.equal(card(store, ids.review).review_subject_assignment_id, replacement.id);
  assert.throws(() => store.closeAssignment({ taskId: task.id, assignmentId: replacement.id, reason: "Loop.", replacedBy: ids.review }), /make a loop/);
});

test("closing a card with no replacement frees its waiters and closes its review", async (t) => {
  const { store, task, codex, ids } = await plannedChain(t);
  const result = store.closeAssignment({ agentId: codex.id, taskId: task.id, assignmentId: ids.build, reason: "Not needed after all." });
  assert.deepEqual(result.closedReviews, ["Review discovery"]);
  assert.equal(card(store, ids.review).status, "closed");
  assert.deepEqual(dependenciesOf(store, ids.next), [], "the review's waiter stops waiting on a card that will never finish");
  assert.throws(() => store.closeAssignment({ taskId: task.id, assignmentId: ids.next, reason: "" }), /Say why/);
});

test("editing a waiting card changes it in place and refuses a dependency loop", async (t) => {
  const { store, task, codex, ids } = await plannedChain(t);
  store.editAssignment({ agentId: codex.id, taskId: task.id, assignmentId: ids.next, title: "Build installer and rollback", targetAgentName: "" });
  assert.equal(card(store, ids.next).title, "Build installer and rollback");
  assert.equal(card(store, ids.next).target_agent_name, null);
  assert.throws(() => store.editAssignment({ taskId: task.id, assignmentId: ids.build, dependsOn: [ids.next] }), /make a loop/);
});

test("when the team names planners, only they change the board; the owner always may", async (t) => {
  const { store, task, codex, claude, ids } = await plannedChain(t, { team: { planner: ["Codex"] } });
  assert.throws(() => store.closeAssignment({ agentId: claude.id, taskId: task.id, assignmentId: ids.next, reason: "Mine now." }), /Only Codex change the board/);
  store.editAssignment({ agentId: codex.id, taskId: task.id, assignmentId: ids.next, title: "Codex may" });
  store.editAssignment({ taskId: task.id, assignmentId: ids.next, title: "The owner may" });
  assert.equal(card(store, ids.next).title, "The owner may");
});

test("asking for a second review of the same work re-addresses the open one instead", async (t) => {
  const { store, task, codex, ids } = await plannedChain(t);
  const again = store.createAssignment({ agentId: codex.id, taskId: task.id, title: "Review discovery (Gemini)", description: "Second opinion.", role: "reviewer", reviewSubjectAssignmentId: ids.build, targetAgentName: "Gemini" });
  assert.equal(again.duplicateOf, ids.review);
  assert.equal(card(store, ids.review).target_agent_name, "Gemini");
});

test("the dashboard can reopen, edit and close cards", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-board-rest-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd(), knowledge: { enabled: false } });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { store } = instance;
  const task = store.createTask({ projectId: store.listProjects()[0].id, title: "REST", description: "Card actions.", requiredApprovals: 1 });
  const target = store.createAssignment({ taskId: task.id, title: "Old title", description: "Something.", role: "implementer" });
  const call = (method, suffix, body) => fetch(`${instance.url}/api/tasks/${task.id}/assignments/${target.id}${suffix}`, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${store.token}` }, body: JSON.stringify(body),
  });
  assert.equal((await call("PATCH", "", { title: "New title" })).status, 200);
  assert.equal(card(store, target.id).title, "New title");
  assert.equal((await call("POST", "/close", { reason: "Duplicate." })).status, 200);
  assert.equal(card(store, target.id).status, "closed");
  assert.equal((await call("POST", "/reopen", { note: "Needed after all." })).status, 200);
  assert.equal(card(store, target.id).status, "queued");
});

test("an agent reads the board as a short flowchart with the ids it needs", async (t) => {
  const { store, task, codex, claude, ids } = await plannedChain(t, { team: { planner: ["Codex"], implementer: ["Claude"], reviewer: ["Codex"] } });
  const build = store.claimNextAssignment(claude.id);
  await report(store, claude, build, { changedFiles: ["package.json"] });
  const { board, steps } = store.boardText(task.id);
  const lines = board.split(/\n/);
  assert.equal(steps, 3, "the plan, the build with its review, and the next build");
  assert.match(lines[1], /team: plan Codex · build Claude · review Codex · solo review off/);
  assert.ok(lines.some((line) => line.includes(`Build: Build discovery — done, Claude [${ids.build}]`)), board);
  assert.ok(lines.some((line) => line.includes("↳ ○ Review: Review discovery — waiting") && line.includes(ids.review)), "the review hangs under its build");
  assert.ok(lines.some((line) => line.includes("Build installer") && line.includes("after Step 1")), "the next step says what it waits on");
  assert.ok(board.length < 3000, `short enough to read every time (${board.length} characters)`);
  void codex;
});
