import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DevTeamStore } from "../src/devteam/store.mjs";
import { startDevTeamServer } from "../src/devteam/server.mjs";

// The team setting and solo mode, pinned against the loop that made Stuff Downloader's boards
// unreadable: Codex plans and reviews one turn at a time, so between turns Claude was the only agent
// connected, was handed reviews of its own code, refused them, and every refusal queued a planner
// card. 42 of that project's 62 blocked reports were exactly this.

async function fixture(t, { team, soloReview } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-team-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Team project", process.cwd());
  if (team || soloReview !== undefined) store.updateProject(project.id, { team, soloReview });
  const task = store.createTask({ projectId: project.id, title: "Rebuild", description: "Plan, build, review.", requiredApprovals: 1 });
  return { store, project, task };
}

const reasons = (explanation) => explanation.reasons.map((reason) => reason.code);

// Codex plans a build and its review, then its turn ends. Claude builds.
async function codexPlansClaudeBuilds(t, options) {
  const { store, project, task } = await fixture(t, options);
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI Codex", freshTaskId: task.id });
  const plan = store.claimNextAssignment(codex.id);
  const build = store.createAssignment({ agentId: codex.id, taskId: task.id, title: "Build discovery", description: "Implement it.", role: "implementer", requiresWrite: true });
  const review = store.createAssignment({ agentId: codex.id, taskId: task.id, title: "Review discovery", description: "Review it.", role: "reviewer", reviewSubjectAssignmentId: build.id, dependsOn: [build.id] });
  await store.completeAssignment({ agentId: codex.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  store.disconnectAgent(codex.id, "Turn over.");
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic Claude Code", freshTaskId: task.id });
  const claimed = store.claimNextAssignment(claude.id);
  assert.equal(claimed?.id, build.id);
  await store.completeAssignment({ agentId: claude.id, assignmentId: build.id, claimToken: claimed.claimToken, message: "Built.", changedFiles: ["package.json"] });
  return { store, project, task, claude, build, review };
}

test("solo mode is off by default: the author is never handed its own review, even alone", async (t) => {
  const { store, task, claude, review } = await codexPlansClaudeBuilds(t);

  assert.equal(store.claimNextAssignment(claude.id), null, "Claude wrote it, so Claude does not get the review");
  const mine = store.whyNotClaimable(review.id, claude.id);
  assert.ok(reasons(mine).includes("verifier_is_author"));
  assert.match(mine.reasons.find((reason) => reason.code === "verifier_is_author").detail, /Solo mode is off/);

  // The card says what it is waiting for rather than looking like nobody noticed it.
  const hold = store.taskDetail(task.id).assignments.find((item) => item.id === review.id).schedulingHold;
  assert.equal(hold.reason, "verifier_is_author");
  assert.match(hold.detail, /Waiting for an independent reviewer/);

  // And the review goes to the first reviewer who did not write it, the moment one arrives.
  const codexAgain = store.connectAgent({ name: "Codex", provider: "OpenAI Codex", freshTaskId: task.id });
  assert.equal(store.claimNextAssignment(codexAgain.id)?.id, review.id);
});

test("with solo mode on, the lone author still gets the review, labelled as before", async (t) => {
  const { store, claude, review } = await codexPlansClaudeBuilds(t, { soloReview: true });
  assert.equal(store.claimNextAssignment(claude.id)?.id, review.id);
});

test("the project team routes each role to the agents named for it", async (t) => {
  const team = { planner: ["Codex"], implementer: ["Claude"], reviewer: ["Codex"] };
  const { store, project, task } = await fixture(t, { team });
  assert.deepEqual(store.projectTeam(project.id), { planner: ["Codex"], implementer: ["Claude"], reviewer: ["Codex"] });

  // createTask seeds a planner card. Only Codex plans here, so Claude alone is not handed it.
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic Claude Code", freshTaskId: task.id });
  assert.equal(store.claimNextAssignment(claude.id), null);
  const seeded = store.taskDetail(task.id).assignments[0];
  assert.ok(reasons(store.whyNotClaimable(seeded.id, claude.id)).includes("role_not_on_team"));
  const hold = store.taskDetail(task.id).assignments[0].schedulingHold;
  assert.equal(hold.reason, "waiting_for_team");
  assert.deepEqual(hold.waitingFor, ["Codex"]);

  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI Codex", freshTaskId: task.id });
  const plan = store.claimNextAssignment(codex.id);
  assert.equal(plan?.id, seeded.id);
  const build = store.createAssignment({ agentId: codex.id, taskId: task.id, title: "Build", description: "Build it.", role: "implementer", requiresWrite: true });
  await store.completeAssignment({ agentId: codex.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });

  // Codex is connected and idle, but building is Claude's.
  assert.equal(store.claimNextAssignment(codex.id), null);
  assert.equal(store.claimNextAssignment(claude.id)?.id, build.id);
});

test("an agent a card is addressed to may take it even when the team names someone else", async (t) => {
  const { store, task } = await fixture(t, { team: { implementer: ["Claude"] } });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI Codex", freshTaskId: task.id });
  const plan = store.claimNextAssignment(codex.id);
  const addressed = store.createAssignment({ agentId: codex.id, taskId: task.id, title: "Spike", description: "Codex tries it.", role: "implementer", targetAgentName: "Codex" });
  await store.completeAssignment({ agentId: codex.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  assert.equal(store.claimNextAssignment(codex.id)?.id, addressed.id);
});

test("a review addressed to its own author is opened up instead of stranded", async (t) => {
  const { store, task } = await fixture(t);
  const planner = store.connectAgent({ name: "Planner", provider: "fixture", freshTaskId: task.id });
  const alice = store.connectAgent({ name: "Alice", provider: "fixture", freshTaskId: task.id });
  const bob = store.connectAgent({ name: "Bob", provider: "fixture", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);
  const build = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Build", description: "Build it.", role: "implementer", requiresWrite: true, targetAgentName: "Alice" });
  const review = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Review", description: "Review it.", role: "reviewer", targetAgentName: "Alice", reviewSubjectAssignmentId: build.id, dependsOn: [build.id] });
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  store.disconnectAgent(planner.id, "Done planning.");
  const claimed = store.claimNextAssignment(alice.id);
  await store.completeAssignment({ agentId: alice.id, assignmentId: claimed.id, claimToken: claimed.claimToken, message: "Built.", changedFiles: ["package.json"] });

  // Alice wrote the build and the review was addressed to her: without this, nobody could take it.
  const row = store.db.prepare("SELECT target_agent_name FROM assignments WHERE id = ?").get(review.id);
  assert.equal(row.target_agent_name, null);
  const events = store.taskDetail(task.id).events.filter((event) => event.type === "assignment.retargeted");
  assert.equal(events.length, 1);
  assert.match(events[0].message, /addressed to Alice, who wrote the work it reviews/);
  assert.equal(store.claimNextAssignment(bob.id)?.id, review.id);
});

test("with solo mode off, an author cannot approve its own version even when nobody else is connected", async (t) => {
  const { store, task } = await fixture(t);
  const planner = store.connectAgent({ name: "Planner", provider: "fixture", freshTaskId: task.id });
  const alice = store.connectAgent({ name: "Alice", provider: "fixture", freshTaskId: task.id });
  const bob = store.connectAgent({ name: "Bob", provider: "fixture", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);
  const bobsBuild = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Bob builds", description: "One part.", role: "implementer", requiresWrite: true, targetAgentName: "Bob", paths: ["a/**"] });
  const alicesBuild = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Alice builds", description: "Another part.", role: "implementer", requiresWrite: true, targetAgentName: "Alice", paths: ["b/**"] });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Review Bob's part", description: "Review it.", role: "reviewer", reviewSubjectAssignmentId: bobsBuild.id, dependsOn: [bobsBuild.id, alicesBuild.id] });
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  store.disconnectAgent(planner.id, "Done planning.");
  const bobClaim = store.claimNextAssignment(bob.id);
  await store.completeAssignment({ agentId: bob.id, assignmentId: bobClaim.id, claimToken: bobClaim.claimToken, message: "Built.", changedFiles: ["package.json"] });
  const aliceClaim = store.claimNextAssignment(alice.id);
  await store.completeAssignment({ agentId: alice.id, assignmentId: aliceClaim.id, claimToken: aliceClaim.claimToken, message: "Built.", changedFiles: ["README.md"] });
  store.disconnectAgent(bob.id, "Gone.");

  // Alice may review Bob's part — she did not write it — but she wrote the current version.
  const reviewClaim = store.claimNextAssignment(alice.id);
  await store.completeAssignment({ agentId: alice.id, assignmentId: reviewClaim.id, claimToken: reviewClaim.claimToken, message: "Reviewed Bob's part." });
  assert.throws(() => store.approveTask({ agentId: alice.id, taskId: task.id, summary: "Looks good." }), /solo mode is off/);
});

test("work waiting only for an absent teammate is named, so an idle agent can stop polling", async (t) => {
  const { store, claude, review } = await codexPlansClaudeBuilds(t, { team: { reviewer: ["Codex"] } });
  const waiting = store.workWaitingOnAbsentTeammates(claude.id);
  assert.deepEqual(waiting.map((item) => [item.assignmentId, item.waitingFor]), [[review.id, ["Codex"]]]);
});

test("the team is validated, stored per role, and cleared by an empty list", async (t) => {
  const { store, project } = await fixture(t);
  assert.throws(() => store.updateProject(project.id, { team: { tester: ["Claude"] } }), /Unknown role/);
  store.updateProject(project.id, { team: { reviewer: "Codex, codex, Gemini" } });
  assert.deepEqual(store.projectTeam(project.id).reviewer, ["Codex", "Gemini"], "names are trimmed and de-duplicated case-insensitively");
  store.updateProject(project.id, { team: { reviewer: [] } });
  assert.deepEqual(store.projectTeam(project.id).reviewer, []);
  assert.equal(store.teamSummary(project.id).soloReview, false);
  store.updateProject(project.id, { soloReview: true });
  assert.equal(store.teamSummary(project.id).soloReview, true);
  assert.equal(store.listProjects()[0].team.reviewer.length, 0, "the dashboard's project list carries the team");
});

test("agents are told the team, and an agent left waiting on an absent teammate is told to leave", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-team-mcp-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd(), knowledge: { enabled: false } });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { store } = instance;
  const project = store.listProjects()[0];
  const patched = await fetch(`${instance.url}/api/projects/${project.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${store.token}` },
    body: JSON.stringify({ team: { planner: ["Codex"], reviewer: ["Codex"] }, soloReview: false }),
  });
  assert.equal(patched.status, 200);
  assert.deepEqual((await patched.json()).team.reviewer, ["Codex"]);
  const task = store.createTask({ projectId: project.id, title: "Waiting on Codex", description: "Nothing for Claude yet.", requiredApprovals: 1 });

  const transport = new StreamableHTTPClientTransport(new URL(instance.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${store.token}` } },
  });
  const client = new Client({ name: "devteam-team-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  const joined = await client.callTool({ name: "devteam_join", arguments: { name: "Claude", provider: "Anthropic Claude Code", taskId: task.id } });
  assert.deepEqual(joined.structuredContent.team.reviewer, ["Codex"]);
  const agentId = joined.structuredContent.agent.id;

  // The only open card is the seeded plan, and only Codex plans here.
  const idle = await client.callTool({ name: "devteam_next", arguments: { agentId, timeoutSeconds: 1 } });
  assert.equal(idle.structuredContent.status, "idle");
  assert.equal(idle.structuredContent.keepWaiting, false);
  assert.deepEqual(idle.structuredContent.waitingOnTeammates[0].waitingFor, ["Codex"]);
  assert.match(idle.structuredContent.next, /devteam_leave/);
});

test("a message sent while an agent was away reaches it when it rejoins, even days later", async (t) => {
  const { store, task } = await fixture(t);
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI Codex", freshTaskId: task.id });
  store.disconnectAgent(codex.id, "Turn over.");
  store.humanMessage(task.id, "Codex, please review the installer first.");
  // Two days pass before the owner brings Codex back.
  store.db.prepare("UPDATE agents SET disconnected_at = ? WHERE id = ?").run(new Date(Date.now() - 2 * 86_400_000).toISOString(), codex.id);
  const back = store.connectAgent({ name: "Codex", provider: "OpenAI Codex", freshTaskId: task.id });
  const inbox = store.deliverDirectedMessages(back.id);
  assert.deepEqual(inbox.map((message) => message.message), ["Codex, please review the installer first."]);
});

test("a new task's brief starts from where the previous task ended", async (t) => {
  // Its own project folder, with memory switched on: the note has to be really stored to be carried.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-continuity-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-continuity-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: true }, codegraph: { enabled: false } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); await rm(projectRoot, { recursive: true, force: true }); });
  const project = store.ensureProject("Continuity project", projectRoot);
  const first = store.createTask({ projectId: project.id, title: "Rebuild", description: "Plan, build, review.", requiredApprovals: 1 });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI Codex", freshTaskId: first.id });
  const plan = store.claimNextAssignment(codex.id);
  await store.completeAssignment({ agentId: codex.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "R8 planned; installer and UI still to build." });
  store.knowledgeWrite({ agentId: codex.id, taskId: first.id, category: "pitfalls", title: "The frozen app does not ship packaging", body: "Pin it." });
  const second = store.createTask({ projectId: project.id, title: "Next step", description: "Carry on.", requiredApprovals: 1 });
  store.joinTask(codex.id, second.id);
  const brief = store.taskBrief(codex.id, second.id);
  assert.equal(brief.previousWork.length, 1);
  assert.equal(brief.previousWork[0].title, "Rebuild");
  assert.match(brief.previousWork[0].endedWith, /installer and UI still to build/);
  assert.deepEqual(brief.previousWork[0].learned, ["The frozen app does not ship packaging"]);
});
