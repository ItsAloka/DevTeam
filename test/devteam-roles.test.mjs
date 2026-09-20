import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";
import { normalizeRoleName, roleBehaviour, roleCatalogue, ROLE_NAMES } from "../src/devteam/roles.mjs";

// Roles used to be a per-project vocabulary in .devteam/roles.json, validated on read, cached by
// mtime, and negotiable between agents. Most of this file tested that machinery. There are three
// roles now and they are the same everywhere, so what is left to test is the collapse itself: that
// every older name lands somewhere sensible, that only one of the three can review, and that the
// scheduling behaviour those names used to carry is preserved on rows that already exist.

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-roles-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-roles-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => {
    try { store.close(); } catch { /* some tests close early */ }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  return { store, projectRoot, project: store.ensureProject("Roles project", projectRoot) };
}

test("there are exactly three roles, and only one of them verifies", () => {
  assert.deepEqual(ROLE_NAMES, ["planner", "implementer", "reviewer"]);
  const catalogue = roleCatalogue();
  assert.equal(catalogue.roles.length, 3);
  assert.deepEqual(catalogue.roles.filter((role) => role.verifies).map((role) => role.name), ["reviewer"]);
  assert.deepEqual(catalogue.roles.filter((role) => role.plans).map((role) => role.name), ["planner"]);
  assert.deepEqual(catalogue.roles.filter((role) => role.writes).map((role) => role.name), ["implementer"]);
  // The reviewer is the only one that ships a checklist; the other two are handed work, not questions.
  assert.ok(roleBehaviour("reviewer").checklist.length >= 5);
  assert.deepEqual(roleBehaviour("planner").checklist, []);
  assert.deepEqual(roleBehaviour("implementer").checklist, []);
});

test("every older role name resolves onto one of the three", () => {
  // Research folds into planning; testing folds into implementing; security review is a review.
  assert.equal(normalizeRoleName("researcher"), "planner");
  assert.equal(normalizeRoleName("architect"), "planner");
  assert.equal(normalizeRoleName("tester"), "implementer");
  assert.equal(normalizeRoleName("qa"), "implementer");
  assert.equal(normalizeRoleName("security-reviewer"), "reviewer");
  assert.equal(normalizeRoleName("code-reviewer"), "reviewer");
  assert.equal(normalizeRoleName("REVIEWER"), "reviewer");
  assert.equal(normalizeRoleName("  Reviewer  "), "reviewer");
});

test("an unrecognised role is ordinary implementation work, never accidentally a review", async (t) => {
  // Implementation is the role with no special scheduling power, so a name DevTeam cannot place can
  // never produce a reviewer whose completion earns an approval, or a planner that holds a task open.
  assert.equal(normalizeRoleName("photo-desk"), "implementer");
  assert.equal(normalizeRoleName(""), "implementer");
  assert.equal(normalizeRoleName(null), "implementer");
  assert.equal(roleBehaviour("photo-desk").verifies, false);
  assert.equal(roleBehaviour("photo-desk").plans, false);

  const { store, project } = await fixture(t);
  const task = store.createTask({ projectId: project.id, title: "Improvised", description: "A role nobody declared." });
  const agent = store.connectAgent({ name: "Someone", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  const odd = store.createAssignment({ agentId: agent.id, taskId: task.id, title: "Do the thing", description: "Improvised.", role: "photo-desk" });
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Assigned." });

  const row = store.taskDetail(task.id).assignments.find((item) => item.id === odd.id);
  assert.equal(row.role, "implementer", "the board only ever shows the three");
  assert.equal(row.verifies, 0);
  assert.deepEqual(row.checklist, []);

  // Completing it therefore earns no approval standing.
  const claim = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken, message: "Done." });
  assert.throws(() => store.approveTask({ agentId: agent.id, taskId: task.id, summary: "Fine." }), /reviewer/i);
});

test("an author cannot approve its own work, and a reviewer can send it back", async (t) => {
  const { store, project } = await fixture(t);
  const task = store.createTask({ projectId: project.id, title: "Second piece", description: "Independence still holds." });
  const author = store.connectAgent({ name: "Author", provider: "test", freshTaskId: task.id });
  const checker = store.connectAgent({ name: "Checker", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(author.id);
  store.createAssignment({ agentId: author.id, taskId: task.id, title: "Draft it", description: "Write.", role: "implementer", requiresWrite: true, paths: ["drafts/second.md"] });
  await store.completeAssignment({ agentId: author.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Assigned." });
  const draft = store.claimNextAssignment(author.id);
  await store.completeAssignment({ agentId: author.id, assignmentId: draft.id, claimToken: draft.claimToken, message: "Drafted.", changedFiles: ["drafts/second.md"] });

  // The author has no verifying assignment, so it has no standing at all.
  assert.throws(() => store.approveTask({ agentId: author.id, taskId: task.id, summary: "Looks good to me." }),
    /read-only reviewer assignment/i);
  assert.throws(() => store.requestChanges({ agentId: author.id, taskId: task.id, assignmentId: draft.id, summary: "Actually, no." }),
    /reviewer/i);

  const check = store.createAssignment({ taskId: task.id, title: "Check it", description: "Verify.", role: "reviewer" });
  const checkClaim = store.claimNextAssignment(checker.id);
  assert.equal(checkClaim.id, check.id);
  await store.completeAssignment({ agentId: checker.id, assignmentId: check.id, claimToken: checkClaim.claimToken, message: "Read it closely." });
  const sentBack = store.requestChanges({
    agentId: checker.id, taskId: task.id, assignmentId: draft.id, summary: "Third paragraph contradicts the second.",
  });
  assert.equal(sentBack.changesRequested, true);
  assert.equal(sentBack.routedTo, "Author");
});

test("a database written under the old vocabulary keeps the behaviour its rows were created with", async (t) => {
  const { store, project } = await fixture(t);
  const task = store.createTask({ projectId: project.id, title: "Legacy", description: "Rows from before the collapse." });
  const agent = store.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });

  // Write rows the way an older DevTeam did: the six shipped names, with the behaviour flags it set.
  const legacy = [
    ["legacy-tester", "tester", 1, 0],
    ["legacy-security", "security-reviewer", 1, 0],
    ["legacy-researcher", "researcher", 0, 0],
    ["legacy-planner", "planner", 0, 1],
  ];
  for (const [id, role, verifies, plans] of legacy) {
    store.db.prepare(`
      INSERT INTO assignments (id, task_id, title, description, role, requires_write, status, created_at, verifies, plans, domains)
      VALUES (?, ?, ?, 'legacy', ?, 0, 'queued', ?, ?, ?, '[]')
    `).run(id, task.id, id, role, new Date().toISOString(), verifies, plans);
  }
  // Re-running the migration is what an upgrade does; force it by clearing the guard.
  store.db.prepare("DELETE FROM metadata WHERE key = 'roles_collapsed_to_three'").run();
  const { applySchema } = await import("../src/devteam/schema.mjs");
  applySchema(store.db);

  // Spread: node:sqlite returns null-prototype rows, which deepEqual will not match a literal.
  const roleOf = (id) => ({ ...store.db.prepare("SELECT role, verifies, plans FROM assignments WHERE id = ?").get(id) });
  // Renamed by the behaviour the row carried, not by its name: a `tester` row already counted as
  // review evidence, so demoting it would withdraw evidence an in-flight task may be relying on.
  assert.deepEqual(roleOf("legacy-tester"), { role: "reviewer", verifies: 1, plans: 0 });
  assert.deepEqual(roleOf("legacy-security"), { role: "reviewer", verifies: 1, plans: 0 });
  assert.deepEqual(roleOf("legacy-researcher"), { role: "implementer", verifies: 0, plans: 0 });
  assert.deepEqual(roleOf("legacy-planner"), { role: "planner", verifies: 0, plans: 1 });
});

test("the role catalogue travels with the task, so the dashboard offers the three", async (t) => {
  const { store, project } = await fixture(t);
  const task = store.createTask({ projectId: project.id, title: "Catalogue", description: "d" });
  const detail = store.taskDetail(task.id);
  assert.deepEqual(detail.roleCatalogue.roles.map((role) => role.name), ["planner", "implementer", "reviewer"]);
  assert.equal(store.roleCatalogue().roles.length, 3);
});
