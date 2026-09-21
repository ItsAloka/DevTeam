import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { agentColorIndex, blockedBannerCopy, boardSummary, currentWork, escapeHtml, layoutAssignmentBoard, renderSafeMarkdown, unreadTimelineCount } from "../public/ui-utils.js";

test("the collapsed board line leads with the states a human has to act on", () => {
  assert.equal(boardSummary([]), "Waiting for the plan");
  assert.equal(boardSummary([
    { status: "done" },
    { status: "queued" },
    { status: "claimed" },
    { status: "blocked" },
    { status: "claimed", rework_count: 2 },
    { status: "queued", rework_requested_at: "2026-09-20T08:00:00.000Z" },
  ]), "1 blocked · 2 in rework · 2 in progress · 2 waiting · 1 done");

  // A state nobody is in says nothing at all, so a finished task reads as one clean clause.
  assert.equal(boardSummary([{ status: "done" }, { status: "done" }]), "2 done");
});

test("the strip shows the work that is moving, one kind at a time", () => {
  const board = [
    { id: "a", status: "done" },
    { id: "b", status: "claimed" },
    { id: "c", status: "blocked" },
    { id: "d", status: "queued" },
  ];
  assert.deepEqual(currentWork(board).items.map((item) => item.id), ["b"], "claimed work wins");
  assert.deepEqual(currentWork(board.filter((item) => item.status !== "claimed")).items.map((item) => item.id), ["c"], "then blocked");
  assert.deepEqual(currentWork([{ id: "d", status: "queued" }]).items.map((item) => item.id), ["d"], "then waiting");
  assert.deepEqual(currentWork([{ id: "a", status: "done" }]), { items: [], more: 0 }, "a finished board shows no chips");

  const crowded = Array.from({ length: 5 }, (_, index) => ({ id: `n${index}`, status: "claimed" }));
  assert.deepEqual(currentWork(crowded).items.length, 3);
  assert.equal(currentWork(crowded).more, 2, "the rest are counted, not listed");
});

test("assignment board lays out an empty task and an isolated note", () => {
  assert.deepEqual(layoutAssignmentBoard([]), { width: 0, height: 0, lanes: [], nodes: [], edges: [] });

  const isolated = layoutAssignmentBoard([{ id: "solo", title: "Stand alone", role: "implementer", dependsOn: [] }]);
  assert.equal(isolated.nodes.length, 1);
  assert.equal(isolated.nodes[0].depth, 0);
  assert.equal(isolated.lanes[0].label, "implementer");
  assert.deepEqual(isolated.edges, []);
});

test("assignment board layers a linear dependency chain from top to bottom", () => {
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
  const chain = new Map(layout.nodes.map((node) => [node.id, node]));
  assert.ok(chain.get("plan").y < chain.get("build").y, "depth runs down the page");
  assert.ok(chain.get("build").y < chain.get("review").y);
  assert.equal(chain.get("plan").x, chain.get("build").x, "a single note per layer stays in one column");
  assert.deepEqual(layout.lanes.map((lane) => lane.label), ["planner", "implementer", "reviewer"]);
  assert.equal(layout.edges.filter((edge) => edge.type === "dependency").length, 2);
  assert.deepEqual(layout.edges.find((edge) => edge.type === "review") && {
    sourceId: layout.edges.find((edge) => edge.type === "review").sourceId,
    targetId: layout.edges.find((edge) => edge.type === "review").targetId,
  }, { sourceId: "review", targetId: "build" });
});

// Rooms add work one piece at a time and rarely record a dependency for it — 69% of this project's
// own 518 assignments have none. Laid out as roots they made a single twenty-note row.
test("assignment board stacks notes that record no dependency, in the order they were added", () => {
  const added = ["write it", "fix the wording", "fix it again", "check it"].map((title, index) => ({
    id: `n${index}`, title, role: index === 3 ? "reviewer" : "implementer", dependsOn: [],
  }));
  const layout = layoutAssignmentBoard(added);
  assert.deepEqual(layout.nodes.map((node) => node.depth), [0, 1, 2, 3], "one below the next, not one wide row");
  assert.equal(new Set(layout.nodes.map((node) => node.x)).size, 1, "a single column");

  // A declared fan-out still reads as a row: the notes that name the same parent share its depth.
  const declared = layoutAssignmentBoard([
    { id: "plan", role: "planner", dependsOn: [] },
    { id: "api", role: "implementer", dependsOn: ["plan"] },
    { id: "ui", role: "implementer", dependsOn: ["plan"] },
  ]);
  const fanned = new Map(declared.nodes.map((node) => [node.id, node]));
  assert.equal(fanned.get("api").depth, 1);
  assert.equal(fanned.get("ui").depth, 1);
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
  assert.equal(byId.get("api").y, byId.get("ui").y, "siblings share a row");
  assert.notEqual(byId.get("api").x, byId.get("ui").x, "and are set apart across it");
  assert.equal(byId.get("review").depth, 2);
  assert.equal(layout.edges.filter((edge) => edge.type === "dependency").length, 4);
  assert.equal(layout.edges.filter((edge) => edge.type === "review").length, 1);
});

// Zooming the board widens its gaps (app.js passes siblingGap/layerGap × zoom). That must spread the
// same picture, never rearrange it: same rows, same order, same card size, only further apart.
test("board zoom spreads the notes apart without moving any of them to a new place", () => {
  const assignments = [
    { id: "plan", role: "planner", dependsOn: [] },
    { id: "api", role: "implementer", dependsOn: ["plan"] },
    { id: "ui", role: "implementer", dependsOn: ["plan"] },
    { id: "docs", role: "implementer", dependsOn: ["plan"] },
    { id: "review", role: "reviewer", dependsOn: ["api", "ui", "docs"], review_subject_assignment_id: "ui" },
  ];
  const at = (zoom) => layoutAssignmentBoard(assignments, { siblingGap: 26 * zoom, layerGap: 46 * zoom });
  const base = at(1);
  assert.deepEqual(base, layoutAssignmentBoard(assignments), "100% is exactly the unzoomed board");
  const spread = at(3);
  const slots = (layout) => layout.nodes.map(({ id, depth, slot, width, height }) => ({ id, depth, slot, width, height }));
  assert.deepEqual(slots(spread), slots(base), "same notes, same rows, same order, same card size");
  const byId = (layout) => new Map(layout.nodes.map((node) => [node.id, node]));
  const [b, s] = [byId(base), byId(spread)];
  assert.ok(s.get("ui").x - s.get("api").x > b.get("ui").x - b.get("api").x, "siblings move apart");
  assert.ok(s.get("api").y - s.get("plan").y > b.get("api").y - b.get("plan").y, "rows move apart");
  assert.ok(spread.width > base.width && spread.height > base.height, "the canvas grows rather than the cards shrinking");
  assert.deepEqual(spread.edges.map((edge) => edge.id), base.edges.map((edge) => edge.id), "every arrow is still drawn");
});

// The map's zoom is a view over a cached layout; these guard the rules app.js has to keep.
test("zoom controls exist and zoom moves positions, not sizes", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  for (const action of ["in", "out", "reset"]) {
    assert.match(html, new RegExp(`<button[^>]*data-board-zoom="${action}"[^>]*aria-label="[^"]+"`), `a labelled ${action} button`);
  }
  assert.match(app, /siblingGap: BOARD_SIBLING_GAP \* boardZoom/, "the board zooms by its gaps");
  assert.match(app, /r="\$\{node\.r\.toFixed\(1\)\}"/, "a file's circle keeps its radius at any zoom");
  assert.match(app, /cx="\$\{sx\(node\.x\)\}"/, "while its position goes through the zoom");
  const zoomMap = app.slice(app.indexOf("function zoomMap("), app.indexOf("function zoomBoard("));
  assert.ok(zoomMap.length > 0 && !/layoutCodeMap\(/.test(zoomMap), "zooming the map never re-runs its simulation");
});

test("a review sits under the work it checks even without a declared dependency", () => {
  const assignments = [
    { id: "plan", role: "planner", dependsOn: [] },
    { id: "api", role: "implementer", dependsOn: ["plan"] },
    { id: "ui", role: "implementer", dependsOn: ["plan"] },
    { id: "review-api", role: "reviewer", review_subject_assignment_id: "api" },
    { id: "review-ui", role: "reviewer", dependsOn: ["ui"], review_subject_assignment_id: "ui" },
  ];
  const layout = layoutAssignmentBoard(assignments);
  const depth = Object.fromEntries(layout.nodes.map((node) => [node.id, node.depth]));
  assert.equal(depth["review-api"], depth.api + 1, "an undeclared review goes directly under its subject");
  assert.equal(depth["review-api"], depth["review-ui"], "parallel reviews share a row instead of stacking");
  const kinds = (id) => layout.edges.filter((edge) => edge.targetId === id || edge.sourceId === id).map((edge) => edge.type).sort();
  assert.deepEqual(kinds("review-api"), ["review"], "the implied link is drawn once, as the review arrow");
  assert.deepEqual(kinds("review-ui"), ["dependency", "review"], "a declared dependency still draws its own arrow");
});

test("undeclared work planned in one burst sits side by side; work added later goes underneath", () => {
  const at = (seconds) => new Date(Date.UTC(2026, 8, 21, 3, 0, 0) + seconds * 1000).toISOString();
  const rows = (assignments) => {
    const layout = layoutAssignmentBoard(assignments);
    const byDepth = new Map();
    for (const node of layout.nodes) byDepth.set(node.depth, [...(byDepth.get(node.depth) || []), node.id]);
    return [...byDepth.keys()].sort((a, b) => a - b).map((depth) => byDepth.get(depth));
  };
  const burst = [
    { id: "plan", role: "planner", plans: 1, created_at: at(0) },
    { id: "api", role: "implementer", created_at: at(60) },
    { id: "ui", role: "implementer", created_at: at(60.1) },
    { id: "review-api", role: "reviewer", review_subject_assignment_id: "api", created_at: at(75) },
    { id: "docs", role: "implementer", created_at: at(90) },
    { id: "review-ui", role: "reviewer", review_subject_assignment_id: "ui", created_at: at(91) },
  ];
  assert.deepEqual(rows(burst), [["plan"], ["api", "ui", "docs"], ["review-api", "review-ui"]],
    "the planner's output goes under it, and a burst reaches past a review to its undeclared peers");

  const later = [
    { id: "plan", role: "planner", plans: 1, created_at: at(0) },
    { id: "first", role: "implementer", created_at: at(60) },
    { id: "follow-up", role: "implementer", created_at: at(60 + 600) },
    { id: "replan", role: "planner", plans: 1, created_at: at(60 + 610) },
  ];
  assert.deepEqual(rows(later), [["plan"], ["first"], ["follow-up"], ["replan"]],
    "a card added ten minutes later, and any planner, goes underneath");
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

// app.js touches the DOM on load, so the real initials() is lifted out of its source and run here.
test("avatar initials escape agent-chosen names", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const line = app.split("\n").find((text) => text.startsWith("const initials = "));
  assert.ok(line, "initials() is defined on one line");
  const initials = new Function("escapeHtml", `${line}\nreturn initials;`)(escapeHtml);
  assert.equal(initials("Codex"), "C");
  assert.equal(initials("Codex Reviewer"), "CR");
  assert.equal(initials("  open ai codex "), "OA");
  assert.equal(initials(), "A");
  assert.equal(initials(null), "A");
  assert.equal(initials("😀 bot"), "😀B", "an emoji is not split in half");
  for (const hostile of ["<img src=x onerror=alert(1)>", "<s", "\"' <b", "&lt; x", "<\n>"]) {
    assert.doesNotMatch(initials(hostile), /[<>"']|&(?!(amp|lt|gt|quot|#39);)/, `${JSON.stringify(hostile)} cannot create markup`);
  }
  assert.equal(initials("<s"), "&lt;");
  const calls = app.match(/\$\{initials\([^)]*\)\}/g) || [];
  assert.equal(calls.length, 2, "both avatar call sites use initials()");
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
