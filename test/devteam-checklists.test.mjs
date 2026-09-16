// Domain checklists are Markdown the owner writes; DevTeam parses them and hands the relevant lines
// to verifying roles. These cover the parser, the brief's selection, and the wiring that resolves
// the directory — plus the two properties that make the feature trustworthy: DevTeam never writes
// into the directory, and an assignment whose domains have no file briefs exactly as before.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";
import { startDevTeamServer } from "../src/devteam/server.mjs";
import {
  availableDomains, checklistBrief, clearChecklistCache, loadChecklist, parseChecklist,
} from "../src/devteam/checklists.mjs";
import { DEFAULT_BRIEF_BUDGET } from "../src/devteam/brief.mjs";

const WEB = `---
domain: web
---

## UI states
- [ ] (*) empty state distinct from loading and error
- [ ] walked every route

## Performance
- [ ] (*) responses compressed
- [-] ruled out for this project
`;

const SECURITY = `---
domain: security
applies_to: [reviewer, security-reviewer]
---

## Auth
- [ ] (*) authz on every protected route
- [ ] sessions revoked on logout
`;

async function checklistDir(t, files = { "web.md": WEB, "security.md": SECURITY }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devteam-checklists-"));
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body, "utf8");
  clearChecklistCache();
  t.after(async () => { clearChecklistCache(); await rm(dir, { recursive: true, force: true }); });
  return dir;
}

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-cl-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-cl-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  store.checklistDir = await checklistDir(t);
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  return { store, project: store.ensureProject("Checklists", projectRoot) };
}

// A reviewer assignment, claimed, so taskBrief has a current assignment to describe.
async function reviewerClaim(store, project, { domains }) {
  const task = store.createTask({ projectId: project.id, title: "Work", description: "d", domains });
  const planner = store.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  const reviewer = store.connectAgent({ name: "Reviewer", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Review", description: "Read.", role: "reviewer" });
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planned." });
  const claim = store.claimNextAssignment(reviewer.id);
  assert.equal(claim.role, "reviewer");
  return { task, reviewer, claim };
}

test("the parser reads sections, criticality and ruled-out lines", () => {
  const parsed = parseChecklist(WEB, "web");
  assert.equal(parsed.domain, "web");
  assert.deepEqual(parsed.sections.map((section) => section.title), ["UI states", "Performance"]);
  // The `[-]` line is parsed but excluded from both counts.
  assert.equal(parsed.itemCount, 3);
  assert.equal(parsed.criticalCount, 2);
  assert.equal(parsed.sections[1].items.at(-1).skipped, true);
  assert.equal(parsed.sections[0].items[0].text, "empty state distinct from loading and error");
  assert.equal(parsed.sections[0].items[0].critical, true);
});

test("frontmatter applies_to limits a file to the roles it names", async (t) => {
  const dir = await checklistDir(t);
  assert.deepEqual(loadChecklist(dir, "security").appliesTo, ["reviewer", "security-reviewer"]);
  assert.equal(checklistBrief(dir, ["security"], "security-reviewer").files.length, 1);
  assert.equal(checklistBrief(dir, ["security"], "implementer"), null);
  // A file without applies_to feeds whoever asks.
  assert.equal(checklistBrief(dir, ["web"], "implementer").files.length, 1);
});

test("only critical lines are inlined, and the budget is shared across files", async (t) => {
  const dir = await checklistDir(t);
  const brief = checklistBrief(dir, ["web"], "reviewer", { always: ["security"], maxItems: 2 });
  assert.deepEqual(brief.files.map((file) => file.domain), ["web", "security"]);
  // Round-robin: one from each file rather than both from the first.
  assert.deepEqual(brief.critical.map((item) => item.domain), ["web", "security"]);
  assert.equal(brief.omitted, 1);
  // Every inlined line is critical and no ruled-out line appears anywhere.
  assert.equal(brief.totalItems, 5);
  assert.ok(!brief.critical.some((item) => item.rule.includes("ruled out")));
});

test("the same rule in two files is one line, and paths point at real files", async (t) => {
  const dir = await checklistDir(t, {
    "web.md": "## A\n- [ ] (*) one rule\n",
    "backend.md": "## B\n- [ ] (*) One Rule\n- [ ] (*) another\n",
  });
  const brief = checklistBrief(dir, ["web", "backend"], "reviewer");
  assert.deepEqual(brief.critical.map((item) => item.rule), ["one rule", "another"]);
  for (const file of brief.files) assert.ok((await stat(file.path)).isFile());
});

test("availableDomains offers only domains with a non-empty file", async (t) => {
  const dir = await checklistDir(t, { "web.md": WEB, "ml.md": "---\ndomain: ml\n---\n\n## General\n" });
  assert.deepEqual(availableDomains(dir, ["web", "ml", "game"]), ["web"]);
  assert.deepEqual(availableDomains(null, ["web"]), []);
});

test("an edited file is re-read without a restart", async (t) => {
  const dir = await checklistDir(t, { "web.md": "## A\n- [ ] (*) first\n" });
  assert.equal(loadChecklist(dir, "web").itemCount, 1);
  await writeFile(path.join(dir, "web.md"), "## A\n- [ ] (*) first\n- [ ] (*) second\n", "utf8");
  assert.equal(loadChecklist(dir, "web").itemCount, 2);
});

test("the brief carries critical items, the file paths, and an instruction to walk them", async (t) => {
  const { store, project } = await fixture(t);
  const { task, reviewer, claim } = await reviewerClaim(store, project, { domains: ["web"] });
  const brief = store.taskBrief(reviewer.id, task.id, { currentAssignment: claim });
  const current = brief.assignment || brief.currentAssignment;
  assert.ok(current.domainChecklist.length, "critical lines are inlined");
  assert.ok(current.domainChecklist.every((item) => typeof item.rule === "string" && item.section));
  // security.md rides along even though the task declared only web.
  assert.deepEqual(current.checklistFiles.map((file) => file.domain), ["web", "security"]);
  assert.match(current.checklistInstruction, /walk the sections your change actually touches/);
  assert.ok(current.domainChecklist.length <= DEFAULT_BRIEF_BUDGET.domainChecklistItems);
});

test("a brief is a pure read: DevTeam never writes into the checklist directory", async (t) => {
  const { store, project } = await fixture(t);
  const before = (await readdir(store.checklistDir)).sort();
  const { task, reviewer, claim } = await reviewerClaim(store, project, { domains: ["web"] });
  store.taskBrief(reviewer.id, task.id, { currentAssignment: claim });
  store.taskBrief(reviewer.id, task.id, { currentAssignment: claim });
  assert.deepEqual((await readdir(store.checklistDir)).sort(), before);
});

test("an assignment whose domains have no file briefs exactly as before", async (t) => {
  const { store, project } = await fixture(t);
  const { task, reviewer, claim } = await reviewerClaim(store, project, { domains: ["game"] });
  const brief = store.taskBrief(reviewer.id, task.id, { currentAssignment: claim });
  const current = brief.assignment || brief.currentAssignment;
  // security.md still applies — it is not opt-in — but nothing from a domain without a file appears.
  assert.deepEqual(current.checklistFiles.map((file) => file.domain), ["security"]);
  assert.ok(!current.domainChecklist.some((item) => item.domain === "game"));
});

test("with no checklist directory at all, the brief carries no checklist keys", async (t) => {
  const { store, project } = await fixture(t);
  store.checklistDir = path.join(os.tmpdir(), "devteam-checklists-absent");
  clearChecklistCache();
  const { task, reviewer, claim } = await reviewerClaim(store, project, { domains: ["web"] });
  const brief = store.taskBrief(reviewer.id, task.id, { currentAssignment: claim });
  const current = brief.assignment || brief.currentAssignment;
  assert.equal(current.domainChecklist, undefined);
  assert.equal(current.checklistFiles, undefined);
});

test("listDomains counts items from the files, and a report records the sections walked", async (t) => {
  const { store, project } = await fixture(t);
  const web = store.listDomains().find((domain) => domain.name === "web");
  assert.equal(web.checklistItems, 3);
  assert.equal(path.basename(web.checklistFile), "web.md");
  assert.equal(store.listDomains().find((domain) => domain.name === "game").checklistItems, 0);

  const { task, reviewer, claim } = await reviewerClaim(store, project, { domains: ["web"] });
  await store.completeAssignment({
    agentId: reviewer.id, assignmentId: claim.id, message: "Reviewed.",
    checklistSections: ["UI states", "UI states", "  Auth  "],
  });
  const event = store.db.prepare(`
    SELECT metadata FROM events WHERE task_id = ? AND type = 'assignment.completed' ORDER BY id DESC LIMIT 1
  `).get(task.id);
  assert.deepEqual(JSON.parse(event.metadata).checklistSections, ["UI states", "Auth"]);
});

test("the server resolves checklistDir onto the store and leaves it untouched", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-cl-server-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-cl-root-"));
  const launchDir = await mkdtemp(path.join(os.tmpdir(), "devteam-cl-launch-"));
  const dir = path.join(launchDir, "checklists");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "web.md"), WEB, "utf8");
  clearChecklistCache();
  const instance = await startDevTeamServer({
    port: 0, dataDir, workspaceRoot: projectRoot, checklistDir: dir,
    knowledge: { enabled: false }, codegraph: { enabled: false },
  });
  t.after(async () => {
    await instance.close().catch(() => {});
    clearChecklistCache();
    for (const target of [dataDir, projectRoot, launchDir]) await rm(target, { recursive: true, force: true });
  });
  assert.equal(instance.store.checklistDir, path.resolve(dir));
  assert.equal(instance.checklistDir, path.resolve(dir));
  // The old system generated files here on start. Nothing should have appeared.
  assert.deepEqual(await readdir(dir), ["web.md"]);
});

test("the legacy checklist tables are dropped from an existing database", async (t) => {
  const { store } = await fixture(t);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.ok(!tables.includes("checklist_items"));
  assert.ok(!tables.includes("checklist_deliveries"));
  // The role base checklist is a different thing and stays.
  assert.ok(tables.includes("assignment_checklists"));
});
