import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";
import { parseChecklistMarkdown, projectChecklistPath, renderChecklistMarkdown, sharedChecklistPath, syncChecklistFiles } from "../src/devteam/checklist-files.mjs";

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-files-"));
  const launchDir = await mkdtemp(path.join(os.tmpdir(), "devteam-files-launch-"));
  const rootA = await mkdtemp(path.join(os.tmpdir(), "devteam-files-a-"));
  const rootB = await mkdtemp(path.join(os.tmpdir(), "devteam-files-b-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => {
    store.close();
    for (const dir of [dataDir, launchDir, rootA, rootB]) await rm(dir, { recursive: true, force: true });
  });
  const a = store.ensureProject("Alpha", rootA);
  const b = store.ensureProject("Beta", rootB);
  const sharedDir = path.join(launchDir, "checklists");
  const projects = [{ id: a.id, root: a.root, name: a.name }, { id: b.id, root: b.root, name: b.name }];
  return { store, a, b, sharedDir, projects };
}

function active(store, { rule, domain = "mobile", section = "Security", scope = "shared", projectId = null }) {
  const item = store._upsertChecklistCandidate({ scope, projectId, domain, section, rule, signature: rule.toLowerCase() });
  return store.approveChecklistItem(item.id);
}

test("render and parse round-trip ids, rules and sections", () => {
  const items = [
    { id: "11111111-1111-4111-8111-111111111111", domain: "web", section: "Security", rule: "Escape user HTML", confirmations: 3, lastSeen: "2026-09-15T00:00:00Z" },
    { id: "22222222-2222-4222-8222-222222222222", domain: "web", section: "Testing", rule: "Test the empty state", confirmations: 1 },
  ];
  const text = renderChecklistMarkdown({ title: "web checklist", items });
  assert.match(text, /## Security\n- \[ \] Escape user HTML\n  <!-- id: 11111111-1111-4111-8111-111111111111 · domain: web · confirmed 3× · last seen 2026-09-15 -->/);
  const parsed = parseChecklistMarkdown(text);
  assert.deepEqual(parsed.exportedIds, items.map((item) => item.id));
  assert.deepEqual(parsed.items.get(items[1].id), { rule: "Test the empty state", section: "Testing" });
  assert.deepEqual(parsed.unlinked, []);
});

test("shared files hold shared active items only; project files hold only that project's items", async (t) => {
  const { store, a, b, sharedDir, projects } = await fixture(t);
  active(store, { rule: "Keychain for tokens" });
  active(store, { rule: "Web rule", domain: "web" });
  active(store, { rule: "Alpha prices are cents", scope: "project", projectId: a.id, section: "Data" });
  store._upsertChecklistCandidate({ scope: "shared", projectId: null, domain: "mobile", section: "UX", rule: "Just a candidate", signature: "just a candidate" });

  const report = syncChecklistFiles(store, { sharedDir, projects });
  const mobile = await readFile(sharedChecklistPath(sharedDir, "mobile"), "utf8");
  assert.match(mobile, /Keychain for tokens/);
  assert.doesNotMatch(mobile, /Just a candidate|Alpha prices|Web rule/);
  assert.match(await readFile(sharedChecklistPath(sharedDir, "web"), "utf8"), /Web rule/);
  const alpha = await readFile(projectChecklistPath(a.root), "utf8");
  assert.match(alpha, /Alpha prices are cents/);
  assert.doesNotMatch(alpha, /Keychain/);
  assert.equal(existsSync(projectChecklistPath(b.root)), false, "no empty project file is created");
  assert.equal(report.written.length, 3);
  assert.deepEqual(syncChecklistFiles(store, { sharedDir, projects }).written, [], "unchanged files are not rewritten");
});

test("exported text is redacted even if an unredacted rule reached the database", async (t) => {
  const { store, sharedDir } = await fixture(t);
  const item = active(store, { rule: "Rotate keys" });
  store.db.prepare("UPDATE checklist_items SET rule = ? WHERE id = ?").run("Never commit password=hunter2hunter2 to config", item.id);
  syncChecklistFiles(store, { sharedDir });
  const text = await readFile(sharedChecklistPath(sharedDir, "mobile"), "utf8");
  assert.doesNotMatch(text, /hunter2/);
  assert.match(text, /REDACTED/);
});

test("owner hand edits are read back: delete retires, reword and move update, added lines are only reported", async (t) => {
  const { store, sharedDir } = await fixture(t);
  const keep = active(store, { rule: "Keychain for tokens" });
  const drop = active(store, { rule: "Pin TLS certificates" });
  syncChecklistFiles(store, { sharedDir });
  const filePath = sharedChecklistPath(sharedDir, "mobile");
  let text = await readFile(filePath, "utf8");
  text = text
    .replace(/- \[ \] Pin TLS certificates\n  <!--[^\n]*-->\n/u, "")
    .replace("- [ ] Keychain for tokens", "- [ ] Store auth tokens only in Keychain or Keystore api_key=sk-abcdefghijklmnopqrstuvwxyz0123")
    .replace("## Security", "## Storage")
    .concat("\n- [ ] A rule the owner typed by hand\n");
  await writeFile(filePath, text, "utf8");

  // Promoted after the last export: absent from the file, but must not be mistaken for a deletion.
  const fresh = active(store, { rule: "Newly promoted rule" });
  const report = syncChecklistFiles(store, { sharedDir });
  assert.deepEqual(report.retired, [drop.id]);
  assert.equal(store.checklistItem(drop.id).status, "expired");
  assert.deepEqual(report.updated, [keep.id]);
  const kept = store.checklistItem(keep.id);
  assert.match(kept.rule, /^Store auth tokens only in Keychain or Keystore/);
  assert.doesNotMatch(kept.rule, /sk-abcdefghij/, "hand edits are redacted too");
  assert.equal(kept.section, "Storage");
  assert.equal(store.checklistItem(fresh.id).status, "active");
  assert.deepEqual(report.unlinked.map((entry) => entry.text), ["A rule the owner typed by hand"]);
  assert.equal(store.listChecklistItems().some((item) => item.rule === "A rule the owner typed by hand"), false);

  const rewritten = await readFile(filePath, "utf8");
  assert.doesNotMatch(rewritten, /Pin TLS/);
  assert.match(rewritten, /Newly promoted rule/);
});

test("a project item id pasted into a shared file is ignored by read-back", async (t) => {
  const { store, a, sharedDir, projects } = await fixture(t);
  active(store, { rule: "Shared rule" });
  const local = active(store, { rule: "Alpha only", scope: "project", projectId: a.id });
  syncChecklistFiles(store, { sharedDir, projects });
  const filePath = sharedChecklistPath(sharedDir, "mobile");
  const text = (await readFile(filePath, "utf8")).replace(/items: ([^ ]+) -->/u, `items: $1,${local.id} -->`);
  await writeFile(filePath, text, "utf8");
  syncChecklistFiles(store, { sharedDir, projects: [] });
  assert.equal(store.checklistItem(local.id).status, "active", "a shared file cannot retire a project item");
});
