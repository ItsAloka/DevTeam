import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DevTeamStore } from "../src/devteam/store.mjs";
import { startDevTeamServer } from "../src/devteam/server.mjs";
import { capDomainChecklist, DEFAULT_BRIEF_BUDGET } from "../src/devteam/brief.mjs";

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-delivery-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-delivery-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); await rm(projectRoot, { recursive: true, force: true }); });
  return { store, project: store.ensureProject("Delivery", projectRoot) };
}

// Seed an active item directly through the lifecycle's own entry points.
function activeItem(store, { domain = "mobile", rule, scope = "shared", projectId = null, section = "Security" }) {
  const item = store._upsertChecklistCandidate({ scope, projectId, domain, section, rule, signature: rule.toLowerCase() });
  return store.approveChecklistItem(item.id);
}

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

test("capDomainChecklist admits a ranked prefix within the item and byte caps", () => {
  const items = Array.from({ length: 30 }, (_, index) => ({ id: String(index), rule: "x".repeat(150) }));
  const byCount = capDomainChecklist(items.slice(0, 20), { maxItems: 15, maxBytes: 1_000_000 });
  assert.equal(byCount.items.length, 15);
  assert.equal(byCount.omitted, 5);
  const byBytes = capDomainChecklist(items, { maxItems: 30, maxBytes: 1_000 });
  assert.ok(JSON.stringify(byBytes.items).length <= 1_000);
  assert.deepEqual(byBytes.items.map((item) => item.id), items.slice(0, byBytes.items.length).map((item) => item.id));
  assert.equal(DEFAULT_BRIEF_BUDGET.domainChecklistItems, 15);
});

test("the brief carries the base checklist plus ranked active domain items, never other projects' items", async (t) => {
  const { store, project } = await fixture(t);
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-delivery-other-"));
  t.after(() => rm(otherRoot, { recursive: true, force: true }));
  const other = store.ensureProject("Other", otherRoot);
  const strong = activeItem(store, { rule: "Store tokens in the Keychain" });
  activeItem(store, { rule: "Weaker rule with no evidence" });
  activeItem(store, { rule: "Web only rule", domain: "web" });
  activeItem(store, { rule: "Other project's own rule", scope: "project", projectId: other.id });
  const mine = activeItem(store, { rule: "Prices are integer cents", scope: "project", projectId: project.id, section: "Data" });
  store._upsertChecklistCandidate({ scope: "shared", projectId: null, domain: "mobile", section: "UX", rule: "Candidate never delivered", signature: "candidate never delivered" });
  // Give `strong` evidence so it ranks first.
  store.db.prepare(`INSERT INTO assignment_findings (id, assignment_id, task_id, requested_by_name, task_version, detail, created_at, checklist_item_id)
    VALUES ('f1', 'x', 'y', 'r', 1, 'd', ?, ?), ('f2', 'x2', 'y2', 'r', 1, 'd', ?, ?)`).run(new Date().toISOString(), strong.id, new Date().toISOString(), strong.id);

  const { task, reviewer, claim } = await reviewerClaim(store, project, { domains: ["mobile"] });
  const brief = store.taskBrief(reviewer.id, task.id, { currentAssignment: claim });
  const current = brief.assignment || brief.currentAssignment;
  assert.ok(current.checklist.length > 0, "the role base checklist is still there");
  const rules = current.domainChecklist.map((item) => item.rule);
  assert.equal(rules[0], strong.rule, "best-confirmed first");
  assert.ok(rules.includes(mine.rule), "this project's own items are delivered");
  assert.ok(!rules.includes("Web only rule"), "other domains are not");
  assert.ok(!rules.includes("Other project's own rule"), "another project's items never leak");
  assert.ok(!rules.includes("Candidate never delivered"), "candidates are not delivered");
  assert.ok(current.checklistFiles.shared.mobile.endsWith(path.join("checklists", "mobile.md")));
  assert.equal(current.checklistFiles.project, path.join(project.root, ".devteam", "checklist.md"));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM checklist_deliveries WHERE assignment_id = ?").get(claim.id).n, rules.length);
  assert.ok(brief.briefMeta.bytes <= brief.briefMeta.limitBytes);
});

test("the delivered set is a snapshot: later items do not change work in flight", async (t) => {
  const { store, project } = await fixture(t);
  activeItem(store, { rule: "First rule" });
  const { task, reviewer, claim } = await reviewerClaim(store, project, { domains: ["mobile"] });
  const first = store.taskBrief(reviewer.id, task.id, { currentAssignment: claim });
  activeItem(store, { rule: "Added later" });
  const again = store.taskBrief(reviewer.id, task.id, { currentAssignment: claim });
  const key = first.assignment ? "assignment" : "currentAssignment";
  assert.deepEqual(again[key].domainChecklist.map((item) => item.rule), ["First rule"]);
  assert.deepEqual(first[key].domainChecklist, again[key].domainChecklist);
});

test("at most 15 domain items are delivered and the brief stays within its byte limit", async (t) => {
  const { store, project } = await fixture(t);
  for (let index = 0; index < 25; index += 1) activeItem(store, { rule: `Rule number ${index} ${"long wording ".repeat(14)}`.slice(0, 200) });
  const { task, reviewer, claim } = await reviewerClaim(store, project, { domains: ["mobile"] });
  const brief = store.taskBrief(reviewer.id, task.id, { currentAssignment: claim });
  const current = brief.assignment || brief.currentAssignment;
  assert.ok(current.domainChecklist.length <= 15);
  assert.ok(current.domainChecklist.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(current.domainChecklist)) <= DEFAULT_BRIEF_BUDGET.domainChecklistBytes);
  assert.ok(brief.briefMeta.omitted.currentAssignmentDomainChecklist >= 10);
  assert.ok(brief.briefMeta.bytes <= brief.briefMeta.limitBytes);
});

test("an assignment without domains briefs exactly as before", async (t) => {
  const { store, project } = await fixture(t);
  activeItem(store, { rule: "Should not appear" });
  const { task, reviewer, claim } = await reviewerClaim(store, project, { domains: [] });
  const brief = store.taskBrief(reviewer.id, task.id, { currentAssignment: claim });
  const current = brief.assignment || brief.currentAssignment;
  assert.equal("domainChecklist" in current, false);
  assert.equal("checklistFiles" in current, false);
  assert.equal("currentAssignmentDomainChecklist" in brief.briefMeta.omitted, false);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM checklist_deliveries").get().n, 0);
});

test("devteam_report applies checklist marks; devteam_verdict accepts rule and section", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-delivery-mcp-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-delivery-mcp-root-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: projectRoot, knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); await rm(projectRoot, { recursive: true, force: true }); });
  const { store } = instance;
  const project = store.listProjects()[0];
  const item = activeItem(store, { rule: "Never log auth tokens" });
  const naItem = activeItem(store, { rule: "Use the platform keystore" });
  const task = store.createTask({ projectId: project.id, title: "MCP delivery", description: "d", domains: ["mobile"] });

  const connect = async (name) => {
    const transport = new StreamableHTTPClientTransport(new URL(instance.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${store.token}` } } });
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(transport);
    t.after(() => client.close());
    const joined = await client.callTool({ name: "devteam_join", arguments: { name, provider: "test", taskId: task.id } });
    return { client, agentId: joined.structuredContent.agent.id };
  };
  const author = await connect("Author");
  const planned = await author.client.callTool({ name: "devteam_next", arguments: { agentId: author.agentId, timeoutSeconds: 1 } });
  const planClaim = planned.structuredContent.assignment;
  await author.client.callTool({ name: "devteam_plan", arguments: { agentId: author.agentId, taskId: task.id, title: "Build", description: "Implement.", requiresWrite: true, paths: ["src/a.mjs"] } });
  await author.client.callTool({ name: "devteam_plan", arguments: { agentId: author.agentId, taskId: task.id, title: "Review", description: "Read.", role: "reviewer" } });
  await author.client.callTool({ name: "devteam_report", arguments: { agentId: author.agentId, assignmentId: planClaim.id, claimToken: planClaim.claimToken, message: "Planned." } });

  const work = (await author.client.callTool({ name: "devteam_next", arguments: { agentId: author.agentId, timeoutSeconds: 1 } })).structuredContent;
  assert.ok(work.assignment.domainChecklist.length === 2, "the implementer is delivered the items");
  const reported = await author.client.callTool({ name: "devteam_report", arguments: {
    agentId: author.agentId, assignmentId: work.assignment.id, claimToken: work.assignment.claimToken, message: "Built.", changedFiles: ["src/a.mjs"],
    checklistMarks: [
      { itemId: item.id, mark: "checked" },
      { itemId: naItem.id, mark: "not-applicable" },
      { itemId: "00000000-0000-4000-8000-000000000000", mark: "checked" },
    ],
  } });
  assert.equal(reported.structuredContent.completed, true);
  assert.equal(reported.structuredContent.checklistMarks.applied.length, 2);
  assert.equal(reported.structuredContent.checklistMarks.rejected.length, 1, "an undelivered item is refused, not thrown");
  assert.equal(store.db.prepare("SELECT mark FROM checklist_deliveries WHERE item_id = ? AND assignment_id = ?").get(naItem.id, work.assignment.id).mark, "not-applicable");

  const reviewer = await connect("Reviewer");
  const review = (await reviewer.client.callTool({ name: "devteam_next", arguments: { agentId: reviewer.agentId, timeoutSeconds: 1 } })).structuredContent;
  assert.equal(review.assignment.role, "reviewer");
  const sentBack = await reviewer.client.callTool({ name: "devteam_verdict", arguments: {
    agentId: reviewer.agentId, verdict: "changes", taskId: task.id, assignmentId: work.assignment.id, summary: "Token logged.",
    findings: [{ detail: "LoginService logs the bearer token at debug level.", path: "src/a.mjs", rule: "Never write auth tokens to logs at any level", section: "Security" }],
  } });
  assert.equal(sentBack.isError ?? false, false, JSON.stringify(sentBack.content));
  const stored = store.db.prepare("SELECT rule, section, checklist_item_id FROM assignment_findings").get();
  assert.equal(stored.rule, "Never write auth tokens to logs at any level");
  assert.equal(stored.section, "Security");
  assert.ok(stored.checklist_item_id, "the verdict fed the checklist lifecycle");
});
