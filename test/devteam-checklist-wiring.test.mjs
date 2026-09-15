import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startDevTeamServer } from "../src/devteam/server.mjs";

async function server(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-wiring-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-wiring-root-"));
  const launchDir = await mkdtemp(path.join(os.tmpdir(), "devteam-wiring-launch-"));
  const checklistDir = path.join(launchDir, "checklists");
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: projectRoot, checklistDir, knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => {
    await instance.close().catch(() => {});
    for (const dir of [dataDir, projectRoot, launchDir]) await rm(dir, { recursive: true, force: true });
  });
  return { instance, checklistDir };
}

const patchTask = (instance, taskId, body) => fetch(`${instance.url}/api/tasks/${taskId}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${instance.store.token}` },
  body: JSON.stringify(body),
});

test("the server resolves checklistDir onto the store and writes shared lists there", async (t) => {
  const { instance, checklistDir } = await server(t);
  const { store } = instance;
  assert.equal(store.checklistDir, path.resolve(checklistDir));
  assert.equal(existsSync(checklistDir), false, "nothing is written while no domain has learned anything");

  const candidate = store._upsertChecklistCandidate({ scope: "shared", projectId: null, domain: "web", section: "Security", rule: "Escape user HTML before rendering", signature: "escape html render user" });
  store.approveChecklistItem(candidate.id);
  instance.syncChecklists();
  const text = await readFile(path.join(checklistDir, "web.md"), "utf8");
  assert.match(text, /Escape user HTML before rendering/);

  // The brief points agents at the same file.
  const project = store.listProjects()[0];
  assert.equal(store._checklistFiles(project.root, ["web"]).shared.web, path.join(path.resolve(checklistDir), "web.md"));
});

test("a change that can alter a list schedules a sync, and close() cancels timers and listeners", async (t) => {
  const { instance, checklistDir } = await server(t);
  const { store } = instance;
  const listenersBefore = store.listenerCount("change");
  const candidate = store._upsertChecklistCandidate({ scope: "shared", projectId: null, domain: "docs", section: "Style", rule: "Every public command has a usage example", signature: "command example public usage" });
  store.approveChecklistItem(candidate.id); // emits checklist.updated → debounced sync
  await new Promise((resolve) => setTimeout(resolve, 2_300));
  assert.ok(existsSync(path.join(checklistDir, "docs.md")), "the debounced sync ran");

  await instance.close();
  assert.equal(store.listenerCount("change"), listenersBefore - 1, "the checklist listener is removed");
  instance.syncChecklists(); // a late call after close is a no-op rather than a use-after-close
});

test("the domains API lists, adds and removes domains, and refuses synonyms", async (t) => {
  const { instance } = await server(t);
  const call = (url, init = {}) => fetch(`${instance.url}${url}`, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${instance.store.token}` } });
  const listed = await (await call("/api/domains")).json();
  assert.ok(listed.some((domain) => domain.name === "security" && domain.builtin));
  const created = await call("/api/domains", { method: "POST", body: JSON.stringify({ name: "quantum" }) });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).name, "quantum");
  const synonym = await call("/api/domains", { method: "POST", body: JSON.stringify({ name: "infra" }) });
  assert.equal(synonym.status, 400);
  assert.match((await synonym.json()).error, /devops/);
  assert.equal((await call("/api/domains/quantum", { method: "DELETE" })).status, 200);
  assert.equal((await call("/api/domains/web", { method: "DELETE" })).status, 400);
});

test("PATCH /api/tasks forwards domains; an unknown domain is a 400", async (t) => {
  const { instance } = await server(t);
  const project = instance.store.listProjects()[0];
  const task = instance.store.createTask({ projectId: project.id, title: "Patch me", description: "d" });

  const ok = await patchTask(instance, task.id, { domains: ["backend", "web"] });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).domains, ["web", "backend"]);
  assert.deepEqual(instance.store.getTask(task.id).domains, ["web", "backend"]);

  const bad = await patchTask(instance, task.id, { domains: ["frontend"] });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Unknown domain/);
  assert.deepEqual(instance.store.getTask(task.id).domains, ["web", "backend"], "a rejected patch changes nothing");
});
