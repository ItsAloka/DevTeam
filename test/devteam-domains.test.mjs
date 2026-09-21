import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DevTeamStore, normalizeDomains } from "../src/devteam/store.mjs";
import { applySchema } from "../src/devteam/schema.mjs";
import { clearChecklistCache, listChecklistDomains } from "../src/devteam/checklists.mjs";

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-domains-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-domains-project-"));
  const checklistDir = await mkdtemp(path.join(os.tmpdir(), "devteam-domains-lists-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  store.checklistDir = checklistDir;
  clearChecklistCache();
  t.after(async () => {
    store.close();
    clearChecklistCache();
    for (const dir of [dataDir, projectRoot, checklistDir]) await rm(dir, { recursive: true, force: true });
  });
  // Writing checklists/<name>.md is the only way to add a domain.
  const writeChecklist = async (name, body = "## General\n- [ ] something\n") => {
    await writeFile(path.join(checklistDir, `${name}.md`), body, "utf8");
    clearChecklistCache();
  };
  // Most tests want a working vocabulary; a domain only exists once its file does.
  for (const name of ["web", "backend", "mobile"]) await writeChecklist(name);
  return { store, checklistDir, writeChecklist, project: store.ensureProject("Domains", projectRoot) };
}

// There is no built-in vocabulary left: a name DevTeam ships a checklist for upstream is still not a
// domain in a project whose checklist directory does not hold that file.
test("a name with no file is not a domain", async (t) => {
  const { store, project, checklistDir } = await fixture(t);
  assert.equal(store.domainNames().includes("desktop"), false, "shipped as an example, but no file here");
  assert.throws(() => store.createTask({ projectId: project.id, title: "D", description: "d", domains: ["desktop"] }), /Unknown domain/);
  // Renaming a file renames the domain: no ghost entry survives for the old name.
  await rm(path.join(checklistDir, "web.md"));
  await writeFile(path.join(checklistDir, "web-frontend.md"), "## A\n- [ ] x\n", "utf8");
  clearChecklistCache();
  assert.equal(store.domainNames().includes("web"), false, "the old name is gone");
  assert.equal(store.domainNames().includes("web-frontend"), true);
});

test("a domain exists because its checklist file exists", async (t) => {
  const { store, project, writeChecklist } = await fixture(t);
  assert.deepEqual(store.domainNames(), ["backend", "mobile", "web"], "only what the directory holds");
  assert.throws(() => store.createTask({ projectId: project.id, title: "Chain", description: "d", domains: ["blockchain"] }), /Unknown domain/);

  await writeChecklist("blockchain");
  assert.equal(store.domainNames().includes("blockchain"), true, "the file registers the domain");
  const listed = store.listDomains().find((domain) => domain.name === "blockchain");
  assert.equal(listed.checklistItems, 1);

  const task = store.createTask({ projectId: project.id, title: "Chain", description: "d", domains: ["blockchain", "web"] });
  assert.deepEqual(task.domains, ["blockchain", "web"], "ordered as the domain list is");
  assert.equal(store.listDomains().find((domain) => domain.name === "blockchain").tasks, 1);
});

test("a domain whose file is deleted stays valid for tasks already using it", async (t) => {
  const { store, project, checklistDir, writeChecklist } = await fixture(t);
  await writeChecklist("blockchain");
  const task = store.createTask({ projectId: project.id, title: "Chain", description: "d", domains: ["blockchain"] });
  await rm(path.join(checklistDir, "blockchain.md"));
  clearChecklistCache();
  // Still in the vocabulary, so the task can be edited rather than failing on a name it carries.
  assert.equal(store.domainNames().includes("blockchain"), true);
  assert.equal(store.listDomains().find((domain) => domain.name === "blockchain").checklistItems, 0);
  assert.deepEqual(store.updateTask(task.id, { title: "Chain v2" }).domains, ["blockchain"]);
});

// The deleted-file allowance is per project: a name one project's old tasks carry must not leak into
// another project's picker, its task counts, or what it accepts.
test("names kept for old tasks stay in their own project", async (t) => {
  const { store, project, checklistDir, writeChecklist } = await fixture(t);
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-domains-other-"));
  t.after(() => rm(otherRoot, { recursive: true, force: true }));
  const other = store.ensureProject("Other", otherRoot);

  await writeChecklist("blockchain");
  store.createTask({ projectId: project.id, title: "Chain", description: "d", domains: ["blockchain", "web"] });
  await rm(path.join(checklistDir, "blockchain.md"));
  clearChecklistCache();

  assert.equal(store.domainNames(project.id).includes("blockchain"), true, "still valid where it is used");
  assert.equal(store.domainNames(other.id).includes("blockchain"), false, "not another project's domain");
  assert.equal(store.listDomains(other.id).find((domain) => domain.name === "web").tasks, 0,
    "task counts are this project's");
  assert.equal(store.listDomains(project.id).find((domain) => domain.name === "web").tasks, 1);
  assert.throws(() => store.createTask({ projectId: other.id, title: "C", description: "d", domains: ["blockchain"] }), /Unknown domain/);
});

test("file names that are not domains are ignored", async (t) => {
  const { store, checklistDir, writeChecklist } = await fixture(t);
  await writeChecklist("README");
  await writeChecklist("frontend", "## A\n- [ ] x\n");
  await writeChecklist("ar-vr");
  clearChecklistCache();
  // web.md exists here, so frontend.md would split one domain's lessons across two lists.
  assert.deepEqual(listChecklistDomains(checklistDir), ["ar-vr", "backend", "mobile", "web"], "README is not a domain, frontend is a synonym of the web.md beside it");
  assert.equal(store.domainNames().includes("frontend"), false);
  assert.equal(store.domainNames().includes("ar-vr"), true);
  // With no web.md there is nothing to split, so the name is the owner's to use.
  await rm(path.join(checklistDir, "web.md"));
  clearChecklistCache();
  assert.equal(listChecklistDomains(checklistDir).includes("frontend"), true);
});

test("the store no longer registers domains itself", async (t) => {
  const { store } = await fixture(t);
  assert.equal(typeof store.addDomain, "undefined");
  assert.equal(typeof store.removeDomain, "undefined");
});

// The allowed names are always passed in, because they come from the checklist directory rather than
// from any list this module holds. Output follows that list's order, not the caller's.
test("normalizeDomains validates, dedupes, lowercases and orders; undefined stays undefined", () => {
  const allowed = ["web", "mobile", "backend"];
  assert.equal(normalizeDomains(undefined, allowed), undefined);
  assert.equal(normalizeDomains(null, allowed), undefined);
  assert.deepEqual(normalizeDomains([], allowed), []);
  assert.deepEqual(normalizeDomains([" Mobile", "web", "mobile"], allowed), ["web", "mobile"]);
  assert.throws(() => normalizeDomains(["nope"], allowed), /Unknown domain\(s\): nope/);
  assert.throws(() => normalizeDomains("web", allowed), /must be an array/);
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
