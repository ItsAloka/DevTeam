import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";

// T2.3 — regression awareness, on agent-asserted results.
//
// This file used to be about verified checks: DevTeam spawned allowlisted commands itself and graded
// them by exit code, and most of these tests exercised the executor, the allowlist and the sandbox.
// That machinery is gone. What is left is the part that made a team out of a room full of agents —
// noticing that a check which used to pass now fails, and routing a fix to whoever plausibly broke
// it — and it now runs on what agents report rather than on what DevTeam ran.
//
// The evidence is weaker and these tests are honest about that: an agent reports `status`, DevTeam
// believes it, and the only thing DevTeam still refuses is a report that contradicts itself.

async function regressionFixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-regress-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-regress-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => {
    try { store.close(); } catch { /* some tests close early */ }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const project = store.ensureProject("Regress project", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Keep it green", description: "Do not break each other's work." });
  const alice = store.connectAgent({ name: "Alice", provider: "test", freshTaskId: task.id });
  const bob = store.connectAgent({ name: "Bob", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(alice.id);
  await store.completeAssignment({ agentId: alice.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  return { store, project, task, alice, bob };
}

// The suite as the agent reports it. Everything here is the agent's word — that is the point.
const suite = (status) => [{ label: "suite", status }];
const GREEN = suite("passed");
const RED = suite("failed");

// Claim a fresh assignment for an agent and report it, returning the report result.
async function doWork(store, agent, task, title, { changedFiles = [], checks = [], paths = undefined } = {}) {
  store.createAssignment({ taskId: task.id, title, description: "Work.", role: "implementer", requiresWrite: true, paths, targetAgentName: agent.name });
  const claim = store.claimNextAssignment(agent.id);
  assert.equal(claim.title, title, `${agent.name} should have claimed ${title}`);
  return { claim, result: await store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: `${title} done.`, changedFiles, checks,
  }) };
}

test("a report that names a failing check cannot also be recorded as done", async (t) => {
  // DevTeam cannot tell whether a check really failed. It can tell that a report saying "this failed"
  // and "this is done" contradicts itself, and that much it still refuses — leaving the claim intact
  // so the agent fixes the work rather than losing its lease over its own honesty.
  const { store, task, alice } = await regressionFixture(t);
  const { claim, result } = await doWork(store, alice, task, "Ship it", { changedFiles: ["src/a.mjs"], checks: RED, paths: ["src/a.mjs"] });
  assert.equal(result.completed, false);
  assert.deepEqual(result.checksFailed.failed, [{ label: "suite" }]);
  assert.match(result.checksFailed.reason, /cannot also be recorded as done/i);

  const row = store.db.prepare("SELECT status, agent_id FROM assignments WHERE id = ?").get(claim.id);
  assert.equal(row.status, "claimed", "the claim is left intact so the agent can fix and report again");
  assert.equal(row.agent_id, alice.id);

  // Reporting the same failure as blocked is the honest path, and it is allowed through.
  const blocked = await store.completeAssignment({
    agentId: alice.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: "The suite is red and I cannot see why.", status: "blocked", checks: RED,
  });
  assert.equal(blocked.completed, true);
  assert.equal(blocked.status, "blocked");
});

test("only the latest report attempt describes the work as it now stands", async (t) => {
  // A refused report leaves the claim intact so the agent can fix and report again. Before this,
  // every attempt appended, so an assignment that reported a failure and then a pass went on showing
  // the failure forever and grew assignment_checks without bound on a retry loop.
  const { store, task, alice } = await regressionFixture(t);
  store.createAssignment({ taskId: task.id, title: "Do the work", description: "Work.", role: "implementer" });
  const claim = store.claimNextAssignment(alice.id);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const refused = await store.completeAssignment({
      agentId: alice.id, assignmentId: claim.id, claimToken: claim.claimToken,
      message: "Not there yet.", checks: [{ label: "unit tests", status: "failed" }],
    });
    assert.equal(refused.completed, false);
  }
  const midway = store.taskDetail(task.id).assignments.find((item) => item.id === claim.id);
  assert.equal(midway.checks.length, 1, "two failed attempts show as one current verdict, not two");
  assert.equal(midway.checks[0].status, "failed");

  const fixed = await store.completeAssignment({
    agentId: alice.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: "Fixed.", checks: [{ label: "unit tests", status: "passed" }],
  });
  assert.equal(fixed.completed, true);

  const card = store.taskDetail(task.id).assignments.find((item) => item.id === claim.id);
  assert.equal(card.checks.length, 1, "the completed assignment shows only its final verdict");
  assert.equal(card.checks[0].status, "passed");

  // The earlier attempts are still on record, marked superseded rather than deleted.
  const history = store.db.prepare("SELECT status, superseded_at FROM assignment_checks WHERE assignment_id = ?").all(claim.id);
  assert.equal(history.length, 3, "every attempt is kept");
  assert.equal(history.filter((row) => row.superseded_at).length, 2);
});

test("a check reported as passing and then as failing is a regression, routed to whoever broke it", async (t) => {
  const { store, task, alice, bob } = await regressionFixture(t);

  // Alice delivers with the suite green. That establishes the baseline.
  const first = await doWork(store, alice, task, "Add the feature", { changedFiles: ["src/feature.mjs"], checks: GREEN, paths: ["src/feature.mjs"] });
  assert.equal(first.result.completed, true);
  assert.equal(first.result.checks[0].status, "passed");
  assert.equal(store.checkBaseline(task.id)[0].status, "passed");
  assert.ok(store.checkBaseline(task.id)[0].lastPassedAt);
  assert.equal(store.openRegressions(task.id).length, 0);

  // Alice then lands a change that breaks it, without running the suite herself.
  const breaking = await doWork(store, alice, task, "Refactor the shared helper", { changedFiles: ["src/helper.mjs"], paths: ["src/helper.mjs"] });
  assert.equal(breaking.result.completed, true, "nothing catches it yet — nobody ran the suite");
  assert.equal(store.openRegressions(task.id).length, 0);

  // Bob, doing unrelated work, runs the suite and trips over Alice's breakage.
  const caught = await doWork(store, bob, task, "Do something else", { changedFiles: ["src/other.mjs"], checks: RED, paths: ["src/other.mjs"] });
  assert.equal(caught.result.completed, false, "a failing check still refuses the report");
  assert.equal(caught.result.regressions.length, 1, "and it is recognised as a regression, not just a failure");

  const regression = caught.result.regressions[0];
  assert.equal(regression.label, "suite");
  assert.equal(regression.attribution, "single");
  assert.equal(regression.suspects.length, 1);
  assert.equal(regression.suspects[0].title, "Refactor the shared helper");
  assert.equal(regression.suspects[0].author, "Alice", "the agent that changed files since it was last green");
  assert.deepEqual(regression.suspects[0].changedFiles, ["src/helper.mjs"]);
  assert.match(caught.result.regressionNote, /not yours/i, "Bob is told this is not his to chase");

  // A fix assignment is queued and addressed to Alice.
  assert.ok(regression.fixAssignmentId);
  const fix = store.taskDetail(task.id).assignments.find((item) => item.id === regression.fixAssignmentId);
  assert.equal(fix.status, "queued");
  assert.equal(fix.target_agent_name, "Alice");
  assert.equal(fix.requires_write, 1);
  assert.match(fix.title, /regression/i);
  assert.match(fix.description, /src\/helper\.mjs/);

  // And it is on the timeline as its own event, not buried in a failed report.
  assert.ok(store.taskDetail(task.id).events.some((event) => event.type === "check.regressed"));
  assert.equal(store.taskDetail(task.id).regressions.length, 1);
});

test("a regression closes itself when the check is reported green again", async (t) => {
  const { store, task, alice, bob } = await regressionFixture(t);
  await doWork(store, alice, task, "Establish green", { changedFiles: ["src/a.mjs"], checks: GREEN, paths: ["src/a.mjs"] });
  await doWork(store, alice, task, "Break it", { changedFiles: ["src/b.mjs"], paths: ["src/b.mjs"] });
  const caught = await doWork(store, bob, task, "Trip over it", { changedFiles: ["src/c.mjs"], checks: RED, paths: ["src/c.mjs"] });
  const fixId = caught.result.regressions[0].fixAssignmentId;
  assert.equal(store.openRegressions(task.id).length, 1);

  // Alice claims the fix and repairs the suite.
  const fixClaim = store.claimNextAssignment(alice.id);
  assert.equal(fixClaim.id, fixId, "the fix is addressed to Alice, so she gets it first");
  const fixed = await store.completeAssignment({
    agentId: alice.id, assignmentId: fixId, claimToken: fixClaim.claimToken,
    message: "Repaired the helper.", changedFiles: ["src/helper.mjs"], checks: GREEN,
  });
  assert.equal(fixed.completed, true);
  assert.equal(store.openRegressions(task.id).length, 0, "a check going green closes what it broke");
  assert.equal(store.checkBaseline(task.id)[0].status, "passed");
});

test("one broken check queues one fix, however many agents trip over it", async (t) => {
  const { store, task, alice, bob } = await regressionFixture(t);
  await doWork(store, alice, task, "Establish green", { changedFiles: ["src/a.mjs"], checks: GREEN, paths: ["src/a.mjs"] });
  await doWork(store, alice, task, "Break it", { changedFiles: ["src/b.mjs"], paths: ["src/b.mjs"] });

  const firstCatch = await doWork(store, bob, task, "First to notice", { changedFiles: ["src/c.mjs"], checks: RED, paths: ["src/c.mjs"] });
  assert.equal(firstCatch.result.regressions.length, 1);
  assert.ok(firstCatch.result.regressions[0].fixAssignmentId);

  // Bob's report was refused, so he still holds that claim. Report it again — the suite is still
  // failing, but the baseline already records the failure, so this is the same breakage, not a new one.
  const second = await store.completeAssignment({
    agentId: bob.id, assignmentId: firstCatch.claim.id, claimToken: firstCatch.claim.claimToken,
    message: "Trying again.", changedFiles: ["src/c.mjs"], checks: RED,
  });
  assert.equal(second.completed, false);
  assert.equal(second.regressions ?? undefined, undefined, "a check that was already failing does not regress twice");
  const fixAssignments = store.taskDetail(task.id).assignments.filter((item) => /regression/i.test(item.title));
  assert.equal(fixAssignments.length, 1, "and the board never accumulates duplicate fix assignments");
});

test("ambiguous attribution says so instead of blaming the first name it finds", async (t) => {
  const { store, task, alice, bob } = await regressionFixture(t);
  await doWork(store, alice, task, "Establish green", { changedFiles: ["src/a.mjs"], checks: GREEN, paths: ["src/a.mjs"] });
  // Two writers land between the last green run and the failure.
  await doWork(store, alice, task, "Alice changes things", { changedFiles: ["src/one.mjs"], paths: ["src/one.mjs"] });
  await doWork(store, bob, task, "Bob changes things", { changedFiles: ["src/two.mjs"], paths: ["src/two.mjs"] });

  const caught = await doWork(store, alice, task, "Run the suite", { changedFiles: ["src/three.mjs"], checks: RED, paths: ["src/three.mjs"] });
  const regression = caught.result.regressions[0];
  assert.equal(regression.attribution, "ambiguous");
  assert.equal(regression.suspects.length, 2);
  const fix = store.taskDetail(task.id).assignments.find((item) => item.id === regression.fixAssignmentId);
  assert.equal(fix.target_agent_name, null, "with two candidates it is not addressed to either of them");
  assert.match(fix.description, /starting point, not a verdict/);
});

test("a bare assertion can neither set a baseline nor manufacture a regression", async (t) => {
  const { store, task, alice, bob } = await regressionFixture(t);
  // A plain string states no outcome. It is recorded, and it moves nothing.
  await doWork(store, alice, task, "Claim it passes", { changedFiles: ["src/a.mjs"], checks: ["the suite passes, trust me"], paths: ["src/a.mjs"] });
  assert.equal(store.checkBaseline(task.id).length, 0, "an assertion establishes nothing");

  const caught = await doWork(store, bob, task, "Actually run it", { changedFiles: ["src/b.mjs"], checks: RED, paths: ["src/b.mjs"] });
  assert.equal(caught.result.completed, false);
  assert.equal(caught.result.regressions ?? undefined, undefined,
    "with no baseline there is nothing to have regressed from — it is a plain failure");
  assert.equal(store.openRegressions(task.id).length, 0);

  // Now establish a real baseline, and confirm an assertion cannot quietly repair it either.
  await doWork(store, alice, task, "Really green", { changedFiles: ["src/c.mjs"], checks: GREEN, paths: ["src/c.mjs"] });
  assert.equal(store.checkBaseline(task.id)[0].status, "passed");
  await doWork(store, alice, task, "Break and assert", { changedFiles: ["src/d.mjs"], checks: ["still fine, honest"], paths: ["src/d.mjs"] });
  assert.equal(store.checkBaseline(task.id)[0].status, "passed", "the assertion did not touch the baseline");

  // An unrecognized status is an assertion too, rather than being guessed into a result.
  await doWork(store, alice, task, "Report nonsense", { changedFiles: ["src/e.mjs"], checks: [{ label: "suite", status: "probably fine" }], paths: ["src/e.mjs"] });
  assert.equal(store.checkBaseline(task.id)[0].status, "passed", "an unreadable status moves nothing either");
});

test("the same suite compares against itself however the agent capitalises it", async (t) => {
  // The baseline key is the label, normalized for case and spacing — the argv DevTeam used to run is
  // no longer available to key on. Two agents typing the same name differently must still compare.
  const { store, task, alice, bob } = await regressionFixture(t);
  await doWork(store, alice, task, "Establish green", { changedFiles: ["src/a.mjs"], checks: [{ label: "npm test", status: "passed" }], paths: ["src/a.mjs"] });
  await doWork(store, alice, task, "Break it", { changedFiles: ["src/b.mjs"], paths: ["src/b.mjs"] });
  const caught = await doWork(store, bob, task, "Trip over it", {
    changedFiles: ["src/c.mjs"], checks: [{ label: "NPM  Test", status: "failed" }], paths: ["src/c.mjs"],
  });
  assert.equal(caught.result.regressions.length, 1, "case and spacing do not make it a different check");
  assert.equal(store.checkBaseline(task.id).length, 1, "and it does not fork the baseline into two rows");
});

test("the team keeps an honest record of who overclaims, who reworks, and who catches breakage", async (t) => {
  const { store, task, alice, bob } = await regressionFixture(t);

  // Alice establishes green, then breaks it without running anything.
  await doWork(store, alice, task, "Establish green", { changedFiles: ["src/a.mjs"], checks: GREEN, paths: ["src/a.mjs"] });
  await doWork(store, alice, task, "Break it", { changedFiles: ["src/b.mjs"], paths: ["src/b.mjs"] });
  // Bob runs the suite and trips over it.
  await doWork(store, bob, task, "Trip over it", { changedFiles: ["src/c.mjs"], checks: RED, paths: ["src/c.mjs"] });

  const aliceRecord = store.agentReliability("Alice");
  const bobRecord = store.agentReliability("Bob");

  assert.equal(aliceRecord.completed, 3, "the planner report plus two pieces of work");
  assert.equal(aliceRecord.regressionsCaused, 1, "and she is the sole suspect for the breakage");
  assert.equal(aliceRecord.refusedByChecks, 0);

  assert.equal(bobRecord.refusedByChecks, 1, "Bob's report was refused because he reported a failing check");
  assert.equal(bobRecord.regressionsCaused, 0, "but he did not cause it");
  assert.equal(bobRecord.regressionsCaught, 1, "he found it, and that counts for him rather than against");
  assert.ok(bobRecord.cleanReportRate < 1);

  // A name nobody has heard of is treated as trustworthy rather than punished for being new.
  const newcomer = store.agentReliability("Someone New");
  assert.equal(newcomer.sample, 0);
  assert.equal(newcomer.cleanReportRate, 1);

  assert.ok(store.teamReliability().some((entry) => entry.agentName === "Alice"));
  assert.equal(store.agentReliability("  "), null);
});

test("an ambiguous regression is not charged to anyone's record", async (t) => {
  const { store, task, alice, bob } = await regressionFixture(t);
  await doWork(store, alice, task, "Establish green", { changedFiles: ["src/a.mjs"], checks: GREEN, paths: ["src/a.mjs"] });
  await doWork(store, alice, task, "Alice changes things", { changedFiles: ["src/one.mjs"], paths: ["src/one.mjs"] });
  await doWork(store, bob, task, "Bob changes things", { changedFiles: ["src/two.mjs"], paths: ["src/two.mjs"] });
  await doWork(store, alice, task, "Run the suite", { changedFiles: ["src/three.mjs"], checks: RED, paths: ["src/three.mjs"] });

  assert.equal(store.openRegressions(task.id).length, 1);
  assert.equal(store.agentReliability("Alice").regressionsCaused, 0,
    "a shared window is a guess, and a guess must not follow someone around as a number");
  assert.equal(store.agentReliability("Bob").regressionsCaused, 0);
});
