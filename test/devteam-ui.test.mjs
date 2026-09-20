import test from "node:test";
import assert from "node:assert/strict";
import { agentColorIndex, blockedBannerCopy, eventMatchesTimelineFilter, layoutAssignmentBoard, renderSafeMarkdown, timelineCategory, unreadTimelineCount } from "../public/ui-utils.js";

test("assignment board lays out an empty task and an isolated note", () => {
  assert.deepEqual(layoutAssignmentBoard([]), { width: 0, height: 0, lanes: [], nodes: [], edges: [] });

  const isolated = layoutAssignmentBoard([{ id: "solo", title: "Stand alone", role: "implementer", dependsOn: [] }]);
  assert.equal(isolated.nodes.length, 1);
  assert.equal(isolated.nodes[0].depth, 0);
  assert.equal(isolated.lanes[0].label, "implementer");
  assert.deepEqual(isolated.edges, []);
});

test("assignment board layers a linear dependency chain from left to right", () => {
  const assignments = [
    { id: "plan", role: "planner", dependsOn: [] },
    { id: "build", role: "implementer", dependsOn: ["plan"] },
    { id: "review", role: "reviewer", dependsOn: ["build"], review_subject_assignment_id: "build" },
  ];
  const layout = layoutAssignmentBoard(assignments);
  assert.deepEqual(layout.nodes.map(({ id, depth }) => ({ id, depth })), [
    { id: "plan", depth: 0 },
    { id: "build", depth: 1 },
    { id: "review", depth: 2 },
  ]);
  assert.deepEqual(layout.lanes.map((lane) => lane.label), ["planner", "implementer", "reviewer"]);
  assert.equal(layout.edges.filter((edge) => edge.type === "dependency").length, 2);
  assert.deepEqual(layout.edges.find((edge) => edge.type === "review") && {
    sourceId: layout.edges.find((edge) => edge.type === "review").sourceId,
    targetId: layout.edges.find((edge) => edge.type === "review").targetId,
  }, { sourceId: "review", targetId: "build" });
});

test("assignment board keeps parallel diamond branches apart before they converge", () => {
  const assignments = [
    { id: "plan", role: "planner", dependsOn: [] },
    { id: "api", role: "implementer", dependsOn: ["plan"] },
    { id: "ui", role: "implementer", dependsOn: ["plan"] },
    { id: "review", role: "reviewer", dependsOn: ["api", "ui"], review_subject_assignment_id: "ui" },
  ];
  const layout = layoutAssignmentBoard(assignments);
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("api").depth, 1);
  assert.equal(byId.get("ui").depth, 1);
  assert.notEqual(byId.get("api").y, byId.get("ui").y);
  assert.equal(byId.get("review").depth, 2);
  assert.equal(layout.edges.filter((edge) => edge.type === "dependency").length, 4);
  assert.equal(layout.edges.filter((edge) => edge.type === "review").length, 1);
});

test("assignment board layout and agent colours are deterministic", () => {
  const assignments = [
    { id: "root", role: "planner", dependsOn: [] },
    { id: "right", role: "implementer", dependsOn: ["root"] },
    { id: "left", role: "implementer", dependsOn: ["root"] },
    { id: "end", role: "reviewer", dependsOn: ["left", "right"] },
  ];
  const snapshot = JSON.stringify(assignments);
  assert.deepEqual(layoutAssignmentBoard(assignments), layoutAssignmentBoard(assignments));
  assert.equal(JSON.stringify(assignments), snapshot, "layout does not mutate the task payload");
  assert.equal(agentColorIndex("Codex"), agentColorIndex("codex"));
  assert.equal(agentColorIndex("Claude"), agentColorIndex("Claude"));
  assert.ok(agentColorIndex("Codex") >= 0 && agentColorIndex("Codex") < 8);
});

test("safe timeline Markdown preserves useful structure without allowing scriptable markup", () => {
  const rendered = renderSafeMarkdown(`# Plan\n\n- item\n- [x] done\n\n\`inline\` and **bold**\n\n[docs](https://example.com/path)\n\n\`\`\`js\nalert('text only')\n\`\`\`\n<img src=x onerror=alert(1)>\n[bad](javascript:alert(1))`);
  assert.match(rendered, /<h3>Plan<\/h3>/);
  assert.match(rendered, /<ul>/);
  assert.match(rendered, /type="checkbox" disabled checked/);
  assert.match(rendered, /<code>inline<\/code>/);
  assert.match(rendered, /<strong>bold<\/strong>/);
  assert.match(rendered, /href="https:\/\/example\.com\/path"/);
  assert.match(rendered, /<pre><code class="language-js">/);
  assert.doesNotMatch(rendered, /<img|href="javascript:|<script/);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/, "unsafe HTML is shown as text");
  assert.match(rendered, /\[bad\]\(javascript:alert\(1\)\)/, "unsupported links remain inert text");
});

test("timeline events map deterministically to the visible filters", () => {
  const cases = [
    [{ type: "human.message" }, "chat"],
    [{ type: "agent.progress" }, "work"],
    [{ type: "agent.decision" }, "decisions"],
    [{ type: "agent.finding" }, "findings"],
    [{ type: "task.created" }, "system"],
  ];
  for (const [event, category] of cases) {
    assert.equal(timelineCategory(event), category);
    assert.equal(eventMatchesTimelineFilter(event, category), true);
    assert.equal(eventMatchesTimelineFilter(event, "all"), true);
  }
  assert.equal(eventMatchesTimelineFilter({ type: "agent.finding" }, "chat"), false);
});

test("unread counts include only newer agent-authored events", () => {
  const events = [
    { id: 10, agent_id: "a", type: "agent.message" },
    { id: 11, agent_id: null, type: "human.message" },
    { id: 12, agent_id: "b", type: "agent.finding" },
  ];
  assert.equal(unreadTimelineCount(events, 10), 1);
  assert.equal(unreadTimelineCount(events, 0), 2);
  assert.equal(unreadTimelineCount(events, 12), 0);
});

test("the blocked banner states the reason, the cost of resuming, and who can take the replan", () => {
  const copy = blockedBannerCopy({
    version: 2,
    reason: "Review was misrouted to its own author.",
    blockedBy: "Codex",
    strandedAssignments: 3,
    resumableBy: ["Codex", "Claude"],
  });
  assert.match(copy.reason, /misrouted/);
  assert.match(copy.meta, /Blocked by Codex/);
  assert.match(copy.meta, /3 assignments stopped mid-flight/);
  assert.match(copy.meta, /agents cannot lift this/);
  assert.match(copy.meta, /reopens the task at v3 and clears its approvals/);
  assert.deepEqual(copy.targets, ["Codex", "Claude"]);

  const sparse = blockedBannerCopy({ version: 1, strandedAssignments: 1 });
  assert.equal(sparse.reason, "No reason was recorded.");
  assert.match(sparse.meta, /^Blocked · 1 assignment stopped mid-flight · v1/);
  assert.deepEqual(sparse.targets, []);

  assert.equal(blockedBannerCopy(null), null, "an unblocked task renders no banner");
});

test("the blocked banner says which kind of blocker it was, in the human's words", () => {
  const overHead = blockedBannerCopy({
    version: 2,
    reason: "This needs a frontier model to do safely.",
    blockedBy: "Claude",
    kind: "over-my-head",
    strandedAssignments: 1,
  });
  assert.match(overHead.meta, /Blocked by Claude — beyond the model or effort the agent had/);

  const needsHuman = blockedBannerCopy({ version: 1, blockedBy: "Codex", kind: "needs-human" });
  assert.match(needsHuman.meta, /needs a decision only you can make/);

  // Blocks recorded before kinds existed carry none. The banner reads exactly as it always did
  // rather than inventing a kind for them.
  const legacy = blockedBannerCopy({ version: 1, blockedBy: "Codex", strandedAssignments: 2 });
  assert.match(legacy.meta, /^Blocked by Codex · 2 assignments stopped mid-flight/);

  const unknown = blockedBannerCopy({ version: 1, blockedBy: "Codex", kind: "something-new" });
  assert.match(unknown.meta, /^Blocked by Codex ·/, "an unrecognised kind is ignored, not printed raw");
});
