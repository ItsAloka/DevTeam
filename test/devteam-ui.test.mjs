import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { agentColorIndex, blockedBannerCopy, boardSummary, buildFlowModel, currentWork, escapeHtml, layoutFlowBoard, renderSafeMarkdown, unreadTimelineCount } from "../public/ui-utils.js";

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
  // Reworked twice and then passed is history, not rework.
  assert.equal(boardSummary([{ status: "done", rework_count: 2 }]), "1 done");
});

test("a finished task says it is finished, and leftover blocked notes are set aside, not blocked", () => {
  // Rebuild 9 was accepted with nine dead notes on it and read "9 blocked · 1 in rework · 12 done".
  const leftovers = [
    { id: "a", status: "done", rework_count: 2 },
    { id: "b", status: "done" },
    { id: "c", status: "blocked" },
    { id: "d", status: "blocked" },
  ];
  assert.equal(boardSummary(leftovers, "accepted"), "Accepted · 2 done · 2 set aside");
  assert.equal(boardSummary(leftovers, "accepted", buildFlowModel(leftovers, { taskStatus: "accepted" })), "Accepted · 2 steps · 2 set aside",
    "with the flow model the line counts what the board draws");
  assert.deepEqual(currentWork(leftovers, 3, "accepted"), { items: [], more: 0 }, "nothing on a finished task is moving");
  assert.equal(boardSummary(leftovers, "active"), "2 blocked · 2 done", "an open task still leads with what is blocked");
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

const flow = (assignments, options = {}, taskStatus = "active") => layoutFlowBoard(buildFlowModel(assignments, { taskStatus }), options);
const rowsOf = (layout) => layout.rows.map((row) => layout.nodes
  .filter((node) => node.kind === "main" && node.y === row.y)
  .sort((left, right) => left.x - right.x)
  .map((node) => node.id));

test("the flow board lays out an empty task and an isolated card", () => {
  assert.deepEqual(flow([]), { width: 0, height: 0, rows: [], nodes: [], edges: [] });
  const isolated = flow([{ id: "solo", title: "Stand alone", role: "implementer", dependsOn: [] }]);
  assert.equal(isolated.nodes.length, 1);
  assert.equal(isolated.rows[0].label, "Step 1");
  assert.deepEqual(isolated.edges, []);
});

test("a review sits directly under the work it reviews, as one step", () => {
  const layout = flow([
    { id: "plan", role: "planner", plans: 1, dependsOn: [] },
    { id: "build", role: "implementer", dependsOn: ["plan"] },
    { id: "review", role: "reviewer", verifies: 1, dependsOn: ["build"], review_subject_assignment_id: "build" },
    { id: "next", role: "implementer", dependsOn: ["review"] },
  ]);
  const at = new Map(layout.nodes.map((node) => [node.id, node]));
  assert.deepEqual(layout.rows.map((row) => row.label), ["Plan", "Step 1", "Step 2"]);
  assert.equal(at.get("review").kind, "review");
  assert.equal(at.get("review").x, at.get("build").x, "the review hangs straight below its build");
  assert.ok(at.get("review").y > at.get("build").y);
  assert.ok(at.get("next").y > at.get("review").y, "the next step comes after the review");
  assert.deepEqual(layout.edges.map((edge) => edge.type).sort(), ["dependency", "dependency", "pair"]);
  const intoNext = layout.edges.find((edge) => edge.targetId === "next");
  assert.equal(intoNext.sourceId, "review", "the arrow leaves from the bottom of the step");
});

// Rooms add work one piece at a time and rarely record a dependency for it — 69% of Not Bagel's
// cards and 51% of Stuff Downloader's have none. Laid out as roots they made one wide row.
test("undeclared work stacks in the order it was added, joined by quiet 'then' arrows", () => {
  const added = ["write it", "fix the wording", "fix it again"].map((title, index) => ({ id: `n${index}`, title, role: "implementer", dependsOn: [] }));
  const layout = flow(added);
  assert.deepEqual(rowsOf(layout), [["n0"], ["n1"], ["n2"]]);
  assert.equal(new Set(layout.nodes.map((node) => node.x)).size, 1, "a single column");
  assert.deepEqual(layout.edges.map((edge) => edge.type), ["sequence", "sequence"]);
});

test("declared parallel work shares a row and converges below", () => {
  const layout = flow([
    { id: "plan", role: "planner", plans: 1, dependsOn: [] },
    { id: "api", role: "implementer", dependsOn: ["plan"] },
    { id: "ui", role: "implementer", dependsOn: ["plan"] },
    { id: "ship", role: "implementer", dependsOn: ["api", "ui"] },
  ]);
  assert.deepEqual(rowsOf(layout), [["plan"], ["api", "ui"], ["ship"]]);
  assert.equal(layout.edges.filter((edge) => edge.type === "dependency").length, 4);
});

test("undeclared work planned in one burst sits side by side; work added later goes underneath", () => {
  const at = (seconds) => new Date(Date.UTC(2026, 8, 21, 3, 0, 0) + seconds * 1000).toISOString();
  const burst = flow([
    { id: "plan", role: "planner", plans: 1, created_at: at(0) },
    { id: "api", role: "implementer", created_at: at(60) },
    { id: "ui", role: "implementer", created_at: at(60.1) },
    { id: "docs", role: "implementer", created_at: at(90) },
    { id: "later", role: "implementer", created_at: at(900) },
  ]);
  assert.deepEqual(rowsOf(burst), [["plan"], ["api", "ui", "docs"], ["later"]]);
});

test("rounds of one review are one card, and a send-back is a loop on the step", () => {
  const layout = flow([
    { id: "build", role: "implementer", rework_count: 2, status: "done" },
    { id: "r1", role: "reviewer", verifies: 1, review_subject_assignment_id: "build", status: "done", created_at: "2026-09-25T05:36:00Z" },
    { id: "r2", role: "reviewer", verifies: 1, review_subject_assignment_id: "build", status: "done", created_at: "2026-09-25T05:43:00Z" },
    { id: "r3", role: "reviewer", verifies: 1, review_subject_assignment_id: "build", status: "done", created_at: "2026-09-25T06:04:00Z" },
  ], {}, "accepted");
  const reviews = layout.nodes.filter((node) => node.kind === "review");
  assert.deepEqual(reviews.map((node) => [node.id, node.rounds]), [["r3", 3]], "the latest round is drawn, the rest are its history");
  assert.deepEqual(reviews[0].history.map((card) => card.id), ["r1", "r2"]);
  const loop = layout.edges.find((edge) => edge.type === "rework");
  assert.equal(loop.label, "sent back 2×");
});

test("an open review round is the one drawn, whatever order the cards were made in", () => {
  const model = buildFlowModel([
    { id: "build", role: "implementer", status: "done" },
    { id: "new", role: "reviewer", verifies: 1, review_subject_assignment_id: "build", status: "queued", review_round: 2, created_at: "2026-09-25T05:00:00Z" },
    { id: "old", role: "reviewer", verifies: 1, review_subject_assignment_id: "build", status: "done", created_at: "2026-09-25T06:00:00Z" },
  ]);
  assert.equal(model.steps[0].review.id, "new");
  assert.equal(model.steps[0].rounds, 2);
});

test("closed, replaced, decided and left-behind cards are set aside, and arrows follow replacements", () => {
  const model = buildFlowModel([
    { id: "plan", role: "planner", plans: 1, status: "done" },
    { id: "old", title: "Old build", role: "implementer", status: "blocked", replaced_by_assignment_id: "new" },
    { id: "decide", role: "planner", plans: 1, status: "done", title: "Resolve blocker: old", resolves_assignment_id: "old" },
    { id: "new", title: "New build", role: "implementer", status: "done" },
    { id: "review", role: "reviewer", verifies: 1, review_subject_assignment_id: "old", status: "done" },
    { id: "next", role: "implementer", status: "done", dependsOn: ["old"] },
    { id: "dropped", role: "implementer", status: "closed", closed_reason: "Not needed." },
    { id: "stuck", role: "implementer", status: "blocked" },
  ], { taskStatus: "accepted" });
  assert.deepEqual(model.steps.map((step) => step.id), ["plan", "new", "next"]);
  assert.equal(model.steps[1].review.id, "review", "a review of the replaced card reviews the replacement");
  assert.deepEqual(model.steps[2].dependsOn, ["new"], "waiting on the replaced card means waiting on its replacement");
  assert.deepEqual(Object.fromEntries(model.setAside.map((entry) => [entry.card.id, entry.reason])), {
    old: "Replaced by “New build”",
    decide: "Decision on “Old build”",
    dropped: "Closed: Not needed.",
    stuck: "Left blocked when the task finished",
  });
});

test("a blocked card on an open task stays in the flow, with its decision attached", () => {
  const model = buildFlowModel([
    { id: "build", role: "implementer", status: "blocked" },
    { id: "decide", role: "planner", plans: 1, status: "claimed", agent_name: "Codex", resolves_assignment_id: "build" },
  ], { taskStatus: "active" });
  assert.deepEqual(model.steps.map((step) => step.id), ["build"]);
  assert.equal(model.steps[0].decision.agent_name, "Codex");
});

// Zooming the board widens its gaps (app.js passes columnGap/rowGap × zoom). That must spread the
// same picture, never rearrange it: same rows, same order, same card size, only further apart.
test("board zoom spreads the steps apart without moving any of them to a new place", () => {
  const assignments = [
    { id: "plan", role: "planner", plans: 1, dependsOn: [] },
    { id: "api", role: "implementer", dependsOn: ["plan"] },
    { id: "ui", role: "implementer", dependsOn: ["plan"] },
    { id: "review", role: "reviewer", verifies: 1, dependsOn: ["ui"], review_subject_assignment_id: "ui" },
  ];
  const base = flow(assignments, { columnGap: 44, rowGap: 60 });
  const spread = flow(assignments, { columnGap: 44 * 3, rowGap: 60 * 3 });
  assert.deepEqual(rowsOf(spread), rowsOf(base), "same steps, same rows, same order");
  assert.deepEqual(spread.nodes.map(({ id, width, height }) => ({ id, width, height })), base.nodes.map(({ id, width, height }) => ({ id, width, height })));
  const at = (layout) => new Map(layout.nodes.map((node) => [node.id, node]));
  assert.ok(at(spread).get("ui").x - at(spread).get("api").x > at(base).get("ui").x - at(base).get("api").x, "siblings move apart");
  assert.ok(spread.width > base.width && spread.height > base.height, "the canvas grows rather than the cards shrinking");
  assert.deepEqual(spread.edges.map((edge) => edge.id), base.edges.map((edge) => edge.id), "every arrow is still drawn");
});

test("the flow board is deterministic, leaves its input alone, and agent colours are stable", () => {
  const assignments = [
    { id: "root", role: "planner", plans: 1, dependsOn: [] },
    { id: "right", role: "implementer", dependsOn: ["root"] },
    { id: "left", role: "implementer", dependsOn: ["root"] },
    { id: "end", role: "reviewer", verifies: 1, dependsOn: ["left", "right"] },
  ];
  const snapshot = JSON.stringify(assignments);
  assert.deepEqual(flow(assignments), flow(assignments));
  assert.equal(JSON.stringify(assignments), snapshot, "layout does not mutate the task payload");
  assert.equal(agentColorIndex("Codex"), agentColorIndex("codex"));
  assert.ok(agentColorIndex("Codex") >= 0 && agentColorIndex("Codex") < 8);
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
  assert.match(app, /columnGap: BOARD_SIBLING_GAP \* boardZoom/, "the board zooms by its gaps");
  assert.match(app, /r="\$\{node\.r\.toFixed\(1\)\}"/, "a file's circle keeps its radius at any zoom");
  assert.match(app, /cx="\$\{sx\(node\.x\)\}"/, "while its position goes through the zoom");
  const zoomMap = app.slice(app.indexOf("function zoomMap("), app.indexOf("function zoomBoard("));
  assert.ok(zoomMap.length > 0 && !/layoutCodeMap\(/.test(zoomMap), "zooming the map never re-runs its simulation");
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
