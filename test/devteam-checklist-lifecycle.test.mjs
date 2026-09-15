import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";
import { CHECKLIST_LEARNED_DELIVERIES, CHECKLIST_NA_WINDOW } from "../src/devteam/store-checklists.mjs";

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-checklists-"));
  const roots = [];
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  const project = async (name) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "devteam-checklists-project-"));
    roots.push(root);
    return store.ensureProject(name, root);
  };
  return { store, project };
}

let counter = 0;
// A task whose implementation is done and whose review is claimed by `reviewerNames[0]`; further
// reviewers get their own verifying assignments so cross-validation can be exercised for real.
async function doneWork(store, project, { domains = ["mobile"], reviewerNames = ["Reviewer"] } = {}) {
  counter += 1;
  const task = store.createTask({ projectId: project.id, title: `Task ${counter}`, description: "d", domains });
  const author = store.connectAgent({ name: `Author${counter}`, provider: "test", freshTaskId: task.id });
  const reviewers = reviewerNames.map((name) => store.connectAgent({ name: `${name}${counter}`, provider: "test", freshTaskId: task.id }));
  const plan = store.claimNextAssignment(author.id);
  store.createAssignment({ agentId: author.id, taskId: task.id, title: "Build", description: "Implement.", role: "implementer", requiresWrite: true });
  reviewerNames.forEach((name, index) => store.createAssignment({
    agentId: author.id, taskId: task.id, title: `Review ${index}`, description: "Read.", role: index === 0 ? "reviewer" : "tester",
  }));
  await store.completeAssignment({ agentId: author.id, assignmentId: plan.id, message: "Planned." });
  const work = store.claimNextAssignment(author.id);
  await store.completeAssignment({ agentId: author.id, assignmentId: work.id, message: "Built.", changedFiles: ["src/a.mjs"] });
  for (const reviewer of reviewers) assert.ok(store.claimNextAssignment(reviewer.id), "each reviewer holds a verifying claim");
  return { task, author, reviewers, work };
}

const sendBack = (store, { task, work }, reviewer, findings) => store.requestChanges({
  agentId: reviewer.id, taskId: task.id, assignmentId: work.id, summary: "Needs changes.", findings,
});

const TOKEN_RULE = { detail: "LoginScreen saves the session token into SharedPreferences.", rule: "Store auth tokens in Keychain or Android Keystore, never plain preferences", section: "Security" };

test("a finding creates a candidate for each task domain; it is not active", async (t) => {
  const { store, project } = await fixture(t);
  const p = await project("App");
  const cycle = await doneWork(store, p, { domains: ["mobile", "backend"] });
  sendBack(store, cycle, cycle.reviewers[0], [TOKEN_RULE]);
  const items = store.listChecklistItems();
  assert.deepEqual(items.map((item) => item.domain).sort(), ["backend", "mobile"]);
  for (const item of items) {
    assert.equal(item.status, "candidate");
    assert.equal(item.scope, "shared");
    assert.equal(item.section, "Security");
    assert.equal(item.rule, TOKEN_RULE.rule);
    assert.equal(item.confirmations, 1);
  }
  const finding = store.db.prepare("SELECT rule, section, checklist_item_id FROM assignment_findings").get();
  assert.equal(finding.rule, TOKEN_RULE.rule);
  assert.ok(finding.checklist_item_id, "the finding is the item's evidence; nothing is copied");
});

test("a task with no domains captures nothing and requestChanges behaves as before", async (t) => {
  const { store, project } = await fixture(t);
  const cycle = await doneWork(store, await project("Plain"), { domains: [] });
  const result = sendBack(store, cycle, cycle.reviewers[0], [TOKEN_RULE]);
  assert.equal(result.changesRequested, true);
  assert.equal(store.listChecklistItems().length, 0);
  assert.equal(store.db.prepare("SELECT checklist_item_id FROM assignment_findings").get().checklist_item_id, null);
});

test("recurrence on two different tasks promotes; the same task twice does not", async (t) => {
  const { store, project } = await fixture(t);
  const p = await project("App");
  const first = await doneWork(store, p);
  sendBack(store, first, first.reviewers[0], [TOKEN_RULE, { ...TOKEN_RULE, detail: "Also in SettingsScreen." }]);
  assert.equal(store.listChecklistItems()[0].status, "candidate", "two findings on one task by one checker stay a candidate");

  const other = await doneWork(store, await project("Other app"));
  sendBack(store, other, other.reviewers[0], [{ ...TOKEN_RULE, detail: "ProfileScreen caches the token in prefs." }]);
  const [item] = store.listChecklistItems();
  assert.equal(item.status, "active");
  assert.equal(item.promoted_by, "recurrence");
  assert.equal(item.distinctTasks, 2);
  assert.equal(store.listChecklistItems().length, 1, "the recurrence merged into one line");
});

test("cross-validation by two different checkers on one task promotes; the same checker twice does not", async (t) => {
  const { store, project } = await fixture(t);
  const cycle = await doneWork(store, await project("App"), { reviewerNames: ["Security", "Tester"] });
  sendBack(store, cycle, cycle.reviewers[0], [TOKEN_RULE]);
  // The author reworks and reports again, then the same reviewer repeats itself: still one checker.
  const rework = store.claimNextAssignment(cycle.author.id);
  await store.completeAssignment({ agentId: cycle.author.id, assignmentId: rework.id, message: "Reworked.", changedFiles: ["src/a.mjs"] });
  sendBack(store, cycle, cycle.reviewers[0], [TOKEN_RULE]);
  assert.equal(store.listChecklistItems()[0].status, "candidate");

  const again = store.claimNextAssignment(cycle.author.id);
  await store.completeAssignment({ agentId: cycle.author.id, assignmentId: again.id, message: "Reworked again.", changedFiles: ["src/a.mjs"] });
  sendBack(store, cycle, cycle.reviewers[1], [TOKEN_RULE]);
  const [item] = store.listChecklistItems();
  assert.equal(item.status, "active");
  assert.equal(item.promoted_by, "cross-validation");
});

test("owner approval promotes a single candidate; rejection is final for capture", async (t) => {
  const { store, project } = await fixture(t);
  const p = await project("App");
  const cycle = await doneWork(store, p);
  sendBack(store, cycle, cycle.reviewers[0], [TOKEN_RULE, { detail: "Button colours differ from the brand palette used elsewhere." }]);
  const [tokenItem, colourItem] = store.listChecklistItems().sort((a, b) => a.rule.localeCompare(b.rule));
  assert.equal(store.approveChecklistItem(colourItem.id).status, "active");
  assert.equal(store.approveChecklistItem(colourItem.id).promoted_by, "owner");
  assert.equal(store.rejectChecklistItem(tokenItem.id).status, "rejected");
  const later = await doneWork(store, await project("Other"));
  sendBack(store, later, later.reviewers[0], [TOKEN_RULE]);
  assert.equal(store.checklistItem(tokenItem.id).status, "rejected", "a rejected rule does not promote itself back");
  assert.throws(() => store.retireChecklistItem(tokenItem.id), /cannot become expired/);
});

test("merging a near-duplicate folds its evidence into the target", async (t) => {
  const { store, project } = await fixture(t);
  const a = await doneWork(store, await project("A"));
  sendBack(store, a, a.reviewers[0], [TOKEN_RULE]);
  const b = await doneWork(store, await project("B"));
  sendBack(store, b, b.reviewers[0], [{ detail: "Token in prefs.", rule: "Never persist session tokens in unencrypted SharedPreferences", section: "Security" }]);
  const items = store.listChecklistItems();
  assert.equal(items.length, 2, "different wording is a different signature");
  const [target, duplicate] = items;
  const merged = store.mergeChecklistItem(duplicate.id, target.id);
  assert.equal(store.checklistItem(duplicate.id).status, "merged");
  assert.equal(merged.id, target.id);
  assert.equal(merged.confirmations, 2);
  assert.equal(merged.status, "active", "merged evidence spans two tasks, so the target is promoted");
});

test("rule text is redacted before it is stored", async (t) => {
  const { store, project } = await fixture(t);
  const cycle = await doneWork(store, await project("App"));
  sendBack(store, cycle, cycle.reviewers[0], [{ detail: "Hardcoded key.", rule: "Never hardcode credentials such as api_key=sk-abcdefghijklmnopqrstuvwxyz123456 in source", section: "Security" }]);
  const [item] = store.listChecklistItems();
  assert.doesNotMatch(item.rule, /sk-abcdefghij/);
  assert.match(item.rule, /REDACTED/);
  assert.doesNotMatch(store.db.prepare("SELECT rule FROM assignment_findings").get().rule, /sk-abcdefghij/);
  assert.ok(item.rule.length <= 200);
});

test("project items never appear in another project's or the shared listing", async (t) => {
  const { store, project } = await fixture(t);
  const mine = await project("Mine");
  const theirs = await project("Theirs");
  const cycle = await doneWork(store, mine);
  sendBack(store, cycle, cycle.reviewers[0], [{ detail: "Price stored as float.", rule: "All prices are stored as integer cents", section: "Data" }]);
  const [item] = store.listChecklistItems();
  store.moveChecklistItem(item.id, { scope: "project", projectId: mine.id });
  assert.equal(store.listChecklistItems().length, 0, "not shared");
  assert.equal(store.listChecklistItems({ projectId: theirs.id }).length, 0, "not another project's");
  assert.equal(store.listChecklistItems({ projectId: mine.id }).length, 1);
});

function deliver(store, itemId, count, mark, startAt = Date.now()) {
  for (let index = 0; index < count; index += 1) {
    const assignmentId = `a-${itemId.slice(0, 6)}-${mark}-${startAt}-${index}`;
    const at = new Date(startAt + index).toISOString();
    store._recordChecklistDelivery(itemId, assignmentId, at);
    if (mark) {
      store.db.prepare("UPDATE checklist_deliveries SET mark = ?, marked_at = ? WHERE item_id = ? AND assignment_id = ?").run(mark, at, itemId, assignmentId);
    }
  }
}

async function activeItem(store, project) {
  const cycle = await doneWork(store, await project(`P${counter}`));
  sendBack(store, cycle, cycle.reviewers[0], [TOKEN_RULE]);
  const [item] = store.listChecklistItems();
  return store.approveChecklistItem(item.id);
}

test("mostly not-applicable over the last 10 deliveries expires automatically", async (t) => {
  const { store, project } = await fixture(t);
  const item = await activeItem(store, project);
  deliver(store, item.id, 4, "checked", Date.now() - 100_000);
  deliver(store, item.id, CHECKLIST_NA_WINDOW - 5, "not-applicable", Date.now() - 50_000);
  assert.deepEqual(store.evaluateChecklistExpiry().expired, [], "5 of 9 marks is under the window");
  deliver(store, item.id, 1, "not-applicable", Date.now());
  assert.deepEqual(store.evaluateChecklistExpiry().expired, [item.id]);
  const expired = store.checklistItem(item.id);
  assert.equal(expired.status, "expired");
  assert.equal(expired.expired_reason, "not-applicable");
});

test("learned expiry is queued for the owner, not applied; pinned items are exempt", async (t) => {
  const { store, project } = await fixture(t);
  const item = await activeItem(store, project);
  deliver(store, item.id, CHECKLIST_LEARNED_DELIVERIES, "checked", Date.now() - 1000);
  const sweep = store.evaluateChecklistExpiry();
  assert.deepEqual(sweep.pendingOwnerConfirmation, [item.id]);
  assert.equal(store.checklistItem(item.id).status, "active", "still delivered until the owner confirms");
  assert.equal(store.retireChecklistItem(item.id, "learned").status, "expired");

  const pinned = await activeItem(store, project).catch(() => null);
  // activeItem reuses the same rule, so the new finding reactivated the expired one instead.
  assert.equal(pinned.id, item.id);
  store.pinChecklistItem(item.id);
  deliver(store, item.id, CHECKLIST_LEARNED_DELIVERIES, "not-applicable", Date.now() + 1000);
  assert.deepEqual(store.evaluateChecklistExpiry(), { expired: [], pendingOwnerConfirmation: [] });
});

test("a violation cancels pending expiry, and re-violation reactivates an expired item with its old count", async (t) => {
  const { store, project } = await fixture(t);
  const item = await activeItem(store, project);
  deliver(store, item.id, CHECKLIST_LEARNED_DELIVERIES, "checked", Date.now() - 1000);
  store.evaluateChecklistExpiry();
  const assignmentId = "violating-assignment";
  store._recordChecklistDelivery(item.id, assignmentId);
  store.markChecklistItem({ itemId: item.id, assignmentId, mark: "violated" });
  assert.equal(store.checklistItem(item.id).expiry_pending_at, null);

  store.retireChecklistItem(item.id);
  const before = store.checklistItem(item.id).confirmations;
  store._recordChecklistDelivery(item.id, "later-assignment");
  const back = store.markChecklistItem({ itemId: item.id, assignmentId: "later-assignment", mark: "violated" });
  assert.equal(back.status, "active");
  assert.equal(back.promoted_by, "reactivated");
  assert.equal(back.confirmations, before, "not re-learned from zero");

  store.retireChecklistItem(item.id);
  const repeat = await doneWork(store, await project("Repeat"));
  sendBack(store, repeat, repeat.reviewers[0], [TOKEN_RULE]);
  const viaFinding = store.checklistItem(item.id);
  assert.equal(viaFinding.status, "active", "a new finding also brings it back");
  assert.equal(viaFinding.confirmations, before + 1);
  assert.throws(() => store.markChecklistItem({ itemId: item.id, assignmentId: "never-delivered", mark: "checked" }), /not delivered/);
});

test("an adopted role proposal carries the project's role base checklist", async (t) => {
  const { store, project } = await fixture(t);
  const p = await project("Proposals");
  const task = store.createTask({ projectId: p.id, title: "Vote", description: "d" });
  const alice = store.connectAgent({ name: "Alice", provider: "test", freshTaskId: task.id });
  const proposal = store.createProposal({ agentId: alice.id, taskId: task.id, kind: "role", summary: "Review it", details: { role: "reviewer", title: "Adopted review", description: "Read." } });
  // The human's vote is decisive, so this adopts through the real path.
  assert.equal(store.voteProposal({ agentId: null, proposalId: proposal.id, vote: "agree" }).status, "adopted");
  const adopted = store.taskDetail(task.id).assignments.find((assignment) => assignment.title === "Adopted review");
  assert.ok(adopted, "the adopted assignment exists");
  assert.ok(adopted.checklist.length > 0, "the reviewer base checklist is attached");
});
