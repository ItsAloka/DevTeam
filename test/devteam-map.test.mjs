// The map view: the project's files, what imports what, and where the team has been.
//
// Two halves, tested separately. `projectMap` is the read that assembles the three recorded
// layers — the code graph, notes that name files, and the files completed assignments reported
// changing. `layoutCodeMap` is the picture, which has to be legible on a real repository rather
// than only on a tidy fixture, so the layout tests assert the properties that legibility actually
// depends on: nothing overlapping, nothing off the canvas, hubs drawn bigger than leaves, and the
// same project drawing the same picture every time.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";
import { normalizeMapPath } from "../src/devteam/store-views.mjs";
import { layoutCodeMap, mapGroupOf } from "../public/ui-utils.js";

// The graph rows are written by hand here rather than indexed, so the fixtures stay small and say
// exactly what each test is about. The indexer has its own tests; this file is about what the map
// makes of what the indexer left behind. The project root is an empty directory for the same
// reason — pointed at the checkout, a live code graph indexes DevTeam itself mid-test.
function withStore(run) {
  const dir = mkdtempSync(path.join(tmpdir(), "devteam-map-"));
  const root = mkdtempSync(path.join(tmpdir(), "devteam-map-root-"));
  const store = new DevTeamStore(dir, { exclusive: false, codegraph: { enabled: false }, knowledge: { enabled: false } });
  try {
    return run(store, root);
  } finally {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

// Notes and reports are written by hand, so their file paths arrive with backslashes, leading
// "./", backticks, and trailing asides. Repairing the obvious damage is what lifts the match rate
// against indexed modules from 65% to 87% on this project's own recorded history.
test("file paths written by hand are repaired before they are matched against the index", () => {
  assert.equal(normalizeMapPath("backend/package.json (reviewed, not edited)"), "backend/package.json");
  assert.equal(normalizeMapPath("backend/src/durable/MediaErasureDO.ts (NEW)"), "backend/src/durable/MediaErasureDO.ts");
  assert.equal(normalizeMapPath("src\\devteam\\store.mjs"), "src/devteam/store.mjs");
  assert.equal(normalizeMapPath("./src/app.js"), "src/app.js");
  assert.equal(normalizeMapPath("`problems.md`"), "problems.md");
  assert.equal(normalizeMapPath("  /frontend/src/main.tsx  "), "frontend/src/main.tsx");
  // A path is never invented out of something that is not one.
  assert.equal(normalizeMapPath(""), "");
  assert.equal(normalizeMapPath(null), "");
});

test("a file belongs to its top level folder, and a file at the root belongs to the root", () => {
  assert.equal(mapGroupOf("backend/src/db/schema.ts"), "backend");
  assert.equal(mapGroupOf("problems.md"), "/");
  assert.equal(mapGroupOf("/leading/slash.ts"), "leading");
  assert.equal(mapGroupOf(""), "/");
});

test("the map carries the code, the notes that name files, and the files this task changed", () => withStore((store, root) => {
  const project = store.ensureProject("Mapped", root);
  const task = store.createTask({ projectId: project.id, title: "Ship it", description: "." });
  store.db.prepare("INSERT INTO code_modules (id, project_id, path, language, hash, size, mtime_ms, exports, dependencies, loc, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("m1", project.id, "src/app.js", "javascript", "h1", 10, 0, "[]", "[]", 120, new Date().toISOString());
  store.db.prepare("INSERT INTO code_modules (id, project_id, path, language, hash, size, mtime_ms, exports, dependencies, loc, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("m2", project.id, "src/lib/util.js", "javascript", "h2", 10, 0, "[]", "[]", 40, new Date().toISOString());
  store.db.prepare("INSERT INTO code_edges (project_id, from_path, to_path, kind) VALUES (?,?,?,?)")
    .run(project.id, "src/app.js", "src/lib/util.js", "import");
  // An edge to a file the graph never indexed, and a file importing itself: both are dropped
  // rather than drawn, because a line to nowhere is worse than a missing line.
  store.db.prepare("INSERT INTO code_edges (project_id, from_path, to_path, kind) VALUES (?,?,?,?)")
    .run(project.id, "src/app.js", "src/gone.js", "import");
  store.db.prepare("INSERT INTO code_edges (project_id, from_path, to_path, kind) VALUES (?,?,?,?)")
    .run(project.id, "src/app.js", "src/app.js", "import");

  const note = (id, status, files) => store.db.prepare(`
    INSERT INTO knowledge_notes (id, project_id, category, slug, title, body, status, confidence, related_files, provenance, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, project.id, "pitfalls", id, `Note ${id}`, "body", status, "high", JSON.stringify(files), "[]", new Date().toISOString(), new Date().toISOString());
  note("n1", "verified", ["src/app.js (reviewed)"]);
  note("n2", "verified", ["docs/only-prose.md"]);
  note("n3", "archived", ["src/lib/util.js"]);

  store._event(task.id, null, "assignment.completed", "done", {
    changedFiles: ["src/app.js (NEW)", "src/app.js", "nowhere/else.js"],
  });

  const map = store.projectMap(task.id);
  assert.deepEqual(map.modules.map((module) => module.path), ["src/app.js", "src/lib/util.js"]);
  assert.deepEqual(map.edges, [{ from: "src/app.js", to: "src/lib/util.js" }], "an edge is drawn only between two indexed files");
  // A note earns a place on the map only by naming a file the map actually draws, and an archived
  // note has already been retired from the vault.
  assert.deepEqual(map.notes.map((item) => item.id), ["n1"]);
  assert.deepEqual(map.notes[0].files, ["src/app.js"]);
  assert.deepEqual(map.touched, [{ file: "src/app.js", count: 2 }], "both spellings count, the unindexed path does not");
  assert.equal(map.projectId, project.id);
}));

test("a task with no completed work maps the code and claims nothing was touched", () => withStore((store, root) => {
  const project = store.ensureProject("Quiet", root);
  const task = store.createTask({ projectId: project.id, title: "Nothing yet", description: "." });
  store.db.prepare("INSERT INTO code_modules (id, project_id, path, language, hash, size, mtime_ms, exports, dependencies, loc, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("m1", project.id, "index.js", "javascript", "h", 1, 0, "[]", "[]", 3, new Date().toISOString());
  const map = store.projectMap(task.id);
  assert.equal(map.modules.length, 1);
  assert.deepEqual(map.touched, []);
  assert.deepEqual(map.notes, []);
}));

test("an unindexed project maps to nothing rather than to an error", () => withStore((store, root) => {
  const project = store.ensureProject("Unindexed", root);
  const task = store.createTask({ projectId: project.id, title: "Fresh", description: "." });
  const map = store.projectMap(task.id);
  assert.deepEqual(map.modules, []);
  assert.deepEqual(map.edges, []);
  assert.deepEqual(layoutCodeMap(map, { width: 800, height: 600 }).nodes, [], "and the picture of nothing is empty");
}));

// A project of a few hundred files, shaped like a real one: two folders of very different sizes,
// a hub everything imports, and a long tail of files nothing imports at all.
function sampleProject({ backend = 90, frontend = 30, loose = 40 } = {}) {
  const modules = [];
  const edges = [];
  for (let index = 0; index < backend; index += 1) modules.push({ path: `backend/src/mod-${index}.ts`, language: "typescript", loc: 50 + index });
  for (let index = 0; index < frontend; index += 1) modules.push({ path: `frontend/src/view-${index}.tsx`, language: "typescript", loc: 30 });
  for (let index = 0; index < loose; index += 1) modules.push({ path: `backend/docs/note-${index}.md`, language: "markdown", loc: 10 });
  modules.push({ path: "backend/src/schema.ts", language: "typescript", loc: 700 });
  for (let index = 0; index < backend; index += 1) edges.push({ from: `backend/src/mod-${index}.ts`, to: "backend/src/schema.ts" });
  for (let index = 1; index < frontend; index += 1) edges.push({ from: `frontend/src/view-${index}.tsx`, to: "frontend/src/view-0.tsx" });
  return { modules, edges, notes: [], touched: [] };
}

test("every file lands inside the panel, and no two files are drawn on top of each other", () => {
  const layout = layoutCodeMap(sampleProject(), { width: 1000, height: 700 });
  assert.equal(layout.nodes.length, 161);
  for (const node of layout.nodes) {
    assert.ok(node.x >= 0 && node.x <= 1000, `${node.path} is off the canvas horizontally at ${node.x}`);
    assert.ok(node.y >= 0 && node.y <= 700, `${node.path} is off the canvas vertically at ${node.y}`);
  }
  // Overlap is the difference between a map and a smudge: the dense folder of a real project
  // arrived with 138 overlapping pairs before the layout pushed circles apart in screen space.
  for (let left = 0; left < layout.nodes.length; left += 1) {
    for (let right = left + 1; right < layout.nodes.length; right += 1) {
      const first = layout.nodes[left];
      const second = layout.nodes[right];
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      assert.ok(distance >= first.r + second.r, `${first.path} and ${second.path} overlap at ${distance.toFixed(1)}px`);
    }
  }
});

test("a file is drawn as big as the number of files that touch it", () => {
  const layout = layoutCodeMap(sampleProject(), { width: 1000, height: 700 });
  const byPath = new Map(layout.nodes.map((node) => [node.path, node]));
  const hub = byPath.get("backend/src/schema.ts");
  const leaf = byPath.get("backend/docs/note-0.md");
  assert.equal(hub.degree, 90);
  assert.equal(leaf.degree, 0);
  assert.ok(hub.r > leaf.r * 2, `the hub (${hub.r}) should dwarf a file nothing imports (${leaf.r})`);
  assert.ok(hub.labelled, "and it is one of the few files named on the map");
});

// The bug this guards: textbook Fruchterman-Reingold pulls a hub's neighbours in once per edge, so
// a file imported ninety times collapses its whole neighbourhood into a dot. Measured on a real
// project, a 37-file folder rendered about 70px across while unconnected files were flung to the rim.
test("a hub does not crush the files that import it into a dot", () => {
  const layout = layoutCodeMap(sampleProject(), { width: 1000, height: 700 });
  const spoke = layout.nodes.filter((node) => /^backend\/src\/mod-/.test(node.path));
  const hub = layout.nodes.find((node) => node.path === "backend/src/schema.ts");
  const spread = Math.max(...spoke.map((node) => Math.hypot(node.x - hub.x, node.y - hub.y)));
  assert.ok(spread > 120, `the hub's importers should occupy a region, not a dot (spread ${spread.toFixed(0)}px)`);
});

test("files of the same folder are drawn nearer each other than files of different folders", () => {
  const layout = layoutCodeMap(sampleProject(), { width: 1000, height: 700 });
  const mean = (values) => values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
  const within = [];
  const across = [];
  for (let left = 0; left < layout.nodes.length; left += 1) {
    for (let right = left + 1; right < layout.nodes.length; right += 1) {
      const first = layout.nodes[left];
      const second = layout.nodes[right];
      (first.group === second.group ? within : across).push(Math.hypot(first.x - second.x, first.y - second.y));
    }
  }
  assert.ok(mean(within) < mean(across), `folders should read as regions (${mean(within).toFixed(0)}px within vs ${mean(across).toFixed(0)}px across)`);
  assert.deepEqual(layout.groups.map((group) => group.name), ["backend", "frontend"]);
  assert.equal(layout.groups.find((group) => group.name === "backend").count, 131);
});

test("the same project draws the same picture every time", () => {
  const project = sampleProject();
  const first = layoutCodeMap(project, { width: 1000, height: 700 });
  const second = layoutCodeMap(project, { width: 1000, height: 700 });
  assert.deepEqual(
    first.nodes.map((node) => [node.path, node.x, node.y, node.r]),
    second.nodes.map((node) => [node.path, node.x, node.y, node.r]),
    "a re-render must not reshuffle the map, or nobody can learn where anything is",
  );
});

test("what the team touched and wrote down is carried onto the map", () => {
  const project = sampleProject();
  project.touched = [{ file: "backend/src/schema.ts", count: 3 }];
  project.notes = [{ id: "n1", category: "pitfalls", title: "Careful here", files: ["frontend/src/view-0.tsx"] }];
  const layout = layoutCodeMap(project, { width: 1000, height: 700 });
  const byPath = new Map(layout.nodes.map((node) => [node.path, node]));
  assert.equal(byPath.get("backend/src/schema.ts").touched, 3);
  assert.ok(byPath.get("backend/src/schema.ts").labelled, "a file this task changed always gets named");
  assert.deepEqual(byPath.get("frontend/src/view-0.tsx").notes.map((note) => note.id), ["n1"]);
  assert.equal(byPath.get("backend/src/mod-1.ts").notes.length, 0);
  // An import touching the task's work is marked so the picture can say where the work landed.
  assert.ok(layout.edges.some((edge) => edge.live), "imports into a changed file are flagged");
  assert.ok(layout.edges.every((edge) => edge.live === (edge.from === "backend/src/schema.ts" || edge.to === "backend/src/schema.ts")));
  assert.equal(layout.groups.find((group) => group.name === "backend").touched, 1);
});

test("labels never sit on top of one another", () => {
  const project = sampleProject();
  project.touched = Array.from({ length: 12 }, (unused, index) => ({ file: `backend/src/mod-${index}.ts`, count: 1 }));
  const layout = layoutCodeMap(project, { width: 1000, height: 700 });
  const labelled = layout.nodes.filter((node) => node.labelled);
  assert.ok(labelled.length > 3, "the hubs and the task's own files are named");
  const boxes = labelled.map((node) => ({
    path: node.path,
    left: node.x - Math.max(14, node.name.length * 2.6),
    right: node.x + Math.max(14, node.name.length * 2.6),
    top: node.y - node.r - 15,
    bottom: node.y - node.r - 3,
  }));
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      const first = boxes[left];
      const second = boxes[right];
      const overlapping = first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
      assert.ok(!overlapping, `labels for ${first.path} and ${second.path} collide`);
    }
  }
});

test("a project past the node budget keeps the work, the notes and the connected core", () => {
  const project = sampleProject({ backend: 60, frontend: 10, loose: 60 });
  project.touched = [{ file: "backend/docs/note-59.md", count: 1 }];
  project.notes = [{ id: "n1", category: "pitfalls", title: "Read me", files: ["backend/docs/note-58.md"] }];
  const layout = layoutCodeMap(project, { width: 1000, height: 700, maxNodes: 40 });
  const paths = new Set(layout.nodes.map((node) => node.path));
  assert.equal(layout.nodes.length, 40);
  assert.equal(layout.dropped, 91);
  assert.ok(paths.has("backend/docs/note-59.md"), "a file this task changed is never dropped");
  assert.ok(paths.has("backend/docs/note-58.md"), "nor is a file the team wrote a note about");
  assert.ok(paths.has("backend/src/schema.ts"), "nor the hub everything imports");
  // Whatever survived, the picture is still a picture: no edge points at a file that was dropped.
  for (const edge of layout.edges) {
    assert.ok(paths.has(edge.from) && paths.has(edge.to), `${edge.from} → ${edge.to} outlived its files`);
  }
});

test("one file, and two files on the same spot, are both drawn without dividing by zero", () => {
  const single = layoutCodeMap({ modules: [{ path: "only.js" }], edges: [] }, { width: 400, height: 300 });
  assert.equal(single.nodes.length, 1);
  assert.ok(Number.isFinite(single.nodes[0].x) && Number.isFinite(single.nodes[0].y));
  const pair = layoutCodeMap({ modules: [{ path: "a.js" }, { path: "a.js" }], edges: [] }, { width: 400, height: 300 });
  for (const node of pair.nodes) assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
});
