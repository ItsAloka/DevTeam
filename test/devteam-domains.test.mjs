import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DevTeamStore, DOMAINS, normalizeDomains } from "../src/devteam/store.mjs";
import { applySchema } from "../src/devteam/schema.mjs";

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-domains-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-domains-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); await rm(projectRoot, { recursive: true, force: true }); });
  return { store, project: store.ensureProject("Domains", projectRoot) };
}

test("the built-in domains are the common IT set and cannot be mutated", () => {
  assert.deepEqual([...DOMAINS], ["web", "backend", "mobile", "desktop", "game", "ml", "data", "devops", "docs", "embedded", "security"]);
  assert.throws(() => { DOMAINS.push("frontend"); });
});

test("the owner can add a domain, use it, and remove it only while unused", async (t) => {
  const { store, project } = await fixture(t);
  assert.deepEqual(store.domainNames(), [...DOMAINS], "built-ins are seeded");
  const added = store.addDomain(" Blockchain ");
  assert.deepEqual({ name: added.name, builtin: added.builtin }, { name: "blockchain", builtin: false });
  assert.equal(store.domainNames().at(-1), "blockchain");

  assert.throws(() => store.addDomain("blockchain"), /already exists/);
  assert.throws(() => store.addDomain("frontend"), /covered by the "web" domain/);
  assert.throws(() => store.addDomain("AI"), /covered by the "ml" domain/);
  assert.throws(() => store.addDomain("../etc"), /lowercase letters/, "names become file names, so no path characters");
  assert.throws(() => store.addDomain("x"), /2–30 characters/);
  assert.equal(store.addDomain("ar vr").name, "ar-vr", "spaces become hyphens");

  const task = store.createTask({ projectId: project.id, title: "Chain", description: "d", domains: ["blockchain", "web"] });
  assert.deepEqual(task.domains, ["web", "blockchain"], "ordered as the domain list is");
  assert.throws(() => store.removeDomain("blockchain"), /in use by 1 task/);
  assert.throws(() => store.removeDomain("web"), /Built-in domains cannot be removed/);
  assert.deepEqual(store.removeDomain("ar-vr"), { removed: "ar-vr" });
  assert.throws(() => store.createTask({ projectId: project.id, title: "Gone", description: "d", domains: ["ar-vr"] }), /Unknown domain/);
});

test("normalizeDomains validates, dedupes, lowercases and orders; undefined stays undefined", () => {
  assert.equal(normalizeDomains(undefined), undefined);
  assert.equal(normalizeDomains(null), undefined);
  assert.deepEqual(normalizeDomains([]), []);
  assert.deepEqual(normalizeDomains([" Mobile", "web", "mobile"]), ["web", "mobile"]);
  assert.throws(() => normalizeDomains(["frontend"]), /Unknown domain\(s\): frontend/);
  assert.throws(() => normalizeDomains("web"), /must be an array/);
});

test("a task with domains persists them and its assignments inherit or override", async (t) => {
  const { store, project } = await fixture(t);
  const task = store.createTask({ projectId: project.id, title: "App", description: "Build it.", domains: ["mobile", "backend"] });
  assert.deepEqual(task.domains, ["backend", "mobile"]);
  assert.deepEqual(store.listTasks(project.id)[0].domains, ["backend", "mobile"]);
  const planner = store.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  store.claimNextAssignment(planner.id);

  const inherited = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Inherit", description: "d" });
  assert.deepEqual(inherited.domains, ["backend", "mobile"]);
  assert.equal(store.db.prepare("SELECT domains FROM assignments WHERE id = ?").get(inherited.id).domains, '["backend","mobile"]');

  const narrowed = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Narrow", description: "d", domains: ["mobile"] });
  assert.deepEqual(narrowed.domains, ["mobile"]);
  const none = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "None", description: "d", domains: [] });
  assert.deepEqual(none.domains, []);

  assert.throws(() => store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Bad", description: "d", domains: ["frontend"] }), /Unknown domain/);
  assert.equal(store.taskDetail(task.id).assignments.some((assignment) => assignment.title === "Bad"), false, "a rejected domain creates nothing");
});

test("invalid domains on task creation are rejected before anything is written", async (t) => {
  const { store, project } = await fixture(t);
  assert.throws(() => store.createTask({ projectId: project.id, title: "Bad", description: "d", domains: ["web", "nope"] }), /Unknown domain/);
  assert.equal(store.listTasks(project.id).length, 0);
});

test("a task with no domains behaves as before: empty list, no domain metadata on events", async (t) => {
  const { store, project } = await fixture(t);
  const task = store.createTask({ projectId: project.id, title: "Plain", description: "No domains." });
  assert.deepEqual(task.domains, []);
  const created = store.taskDetail(task.id).events.find((event) => event.type === "task.created");
  assert.equal("domains" in created.metadata, false);
  const planner = store.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  store.claimNextAssignment(planner.id);
  const work = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Work", description: "d" });
  assert.deepEqual(work.domains, []);
  const event = store.taskDetail(task.id).events.find((entry) => entry.type === "assignment.created" && entry.metadata.assignmentId === work.id);
  assert.equal("domains" in event.metadata, false);
});

test("updateTask changes domains for later assignments only", async (t) => {
  const { store, project } = await fixture(t);
  const task = store.createTask({ projectId: project.id, title: "Evolving", description: "d" });
  const planner = store.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  store.claimNextAssignment(planner.id);
  const before = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Before", description: "d" });
  const updated = store.updateTask(task.id, { domains: ["web"] });
  assert.deepEqual(updated.domains, ["web"]);
  const edit = store.taskDetail(task.id).events.find((event) => event.type === "task.updated");
  assert.deepEqual(edit.metadata.changed, ["domains"]);
  const after = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "After", description: "d" });
  assert.deepEqual(after.domains, ["web"]);
  assert.equal(store.db.prepare("SELECT domains FROM assignments WHERE id = ?").get(before.id).domains, "[]");
  assert.throws(() => store.updateTask(task.id, { domains: ["bogus"] }), /Unknown domain/);
  assert.deepEqual(store.updateTask(task.id, { title: "Evolving" }).domains, ["web"], "omitting domains keeps them");
});

test("the migration adds domains to a database created before the column existed", async (t) => {
  const { store, project } = await fixture(t);
  const task = store.createTask({ projectId: project.id, title: "Legacy", description: "Predates domains." });
  // Reproduce a pre-domains database by removing the columns, then reapply the schema as a restart would.
  const db = new DatabaseSync(":memory:");
  applySchema(db);
  db.exec("ALTER TABLE tasks DROP COLUMN domains; ALTER TABLE assignments DROP COLUMN domains;");
  db.prepare("INSERT INTO projects (id, name, root, created_at) VALUES ('p', 'p', 'r', 'now')").run();
  db.prepare("INSERT INTO tasks (id, project_id, title, description, status, version, required_approvals, created_at, updated_at) VALUES ('legacy', 'p', 't', 'd', 'planning', 1, 2, 'now', 'now')").run();
  applySchema(db);
  assert.ok(db.prepare("PRAGMA table_info(tasks)").all().some((column) => column.name === "domains"));
  assert.ok(db.prepare("PRAGMA table_info(assignments)").all().some((column) => column.name === "domains"));
  assert.equal(db.prepare("SELECT domains FROM tasks WHERE id = 'legacy'").get().domains, "[]");
  db.close();
  assert.deepEqual(task.domains, []);
});
