export function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

const FINISHED_TASK_STATUSES = new Set(["accepted", "cancelled"]);

// Rework is something still to do: a note sent back and not yet reported again. A note that was
// reworked twice and then passed is finished work with a history, not work in rework.
const inRework = (item) => Boolean(item.rework_requested_at)
  || (Number(item.rework_count) > 0 && ["queued", "claimed"].includes(item.status));

// What the board says about itself when it is collapsed to one line. Blocked work and requested
// changes come first: they are the reasons a human would open the board at all. On a finished task
// nothing is asking for anyone, so leftover blocked notes are reported as set aside, not as blocked.
export function boardSummary(assignments = [], taskStatus = null, flow = null) {
  const count = (predicate) => assignments.filter(predicate).length;
  if (FINISHED_TASK_STATUSES.has(taskStatus)) {
    // With the flow model, say it in the board's own terms: steps, and what was set aside from them.
    if (flow) {
      const steps = flow.steps.length;
      return [taskStatus === "accepted" ? "Accepted" : "Cancelled", steps ? `${steps} step${steps === 1 ? "" : "s"}` : null, flow.setAside.length ? `${flow.setAside.length} set aside` : null]
        .filter(Boolean).join(" · ");
    }
    const done = count((item) => item.status === "done");
    const setAside = assignments.length - done;
    return [taskStatus === "accepted" ? "Accepted" : "Cancelled", done ? `${done} done` : null, setAside ? `${setAside} set aside` : null]
      .filter(Boolean).join(" · ");
  }
  if (!assignments.length) return "Waiting for the plan";
  const blocked = count((item) => item.status === "blocked");
  const rework = count(inRework);
  const claimed = count((item) => item.status === "claimed");
  const queued = count((item) => item.status === "queued");
  const done = count((item) => item.status === "done");
  const parts = [];
  if (blocked) parts.push(`${blocked} blocked`);
  if (rework) parts.push(`${rework} in rework`);
  if (claimed) parts.push(`${claimed} in progress`);
  if (queued) parts.push(`${queued} waiting`);
  if (done) parts.push(`${done} done`);
  return parts.join(" · ");
}

// What the closed strip shows: the work that is actually moving. Claimed first, because someone
// has their hands on it right now; then blocked, because that is the board asking for a human; then
// what is waiting to be claimed. Only one of those kinds at a time — a strip that lists everything
// is the old queue again, in one line. A finished task has no work moving at all.
export function currentWork(assignments = [], limit = 3, taskStatus = null) {
  if (FINISHED_TASK_STATUSES.has(taskStatus)) return { items: [], more: 0 };
  const withStatus = (status) => assignments.filter((item) => item.status === status);
  const live = [withStatus("claimed"), withStatus("blocked"), withStatus("queued")].find((group) => group.length) || [];
  const shown = Math.max(1, Number(limit) || 1);
  return { items: live.slice(0, shown), more: Math.max(0, live.length - shown) };
}

export function agentColorIndex(name = "", paletteSize = 8) {
  const size = Math.max(1, Math.floor(Number(paletteSize)) || 1);
  let hash = 2166136261;
  for (const char of String(name).trim().toLowerCase()) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % size;
}

// The top-level folder a file belongs to. Every project this has been measured against is lopsided
// — 244 of Not Bagel's 310 files are under backend/ — so the folder is the only grouping that
// survives contact with a real repository, and it is the one a human already thinks in.
export function mapGroupOf(filePath = "") {
  const clean = String(filePath).replace(/^\/+/, "");
  const cut = clean.indexOf("/");
  return cut > 0 ? clean.slice(0, cut) : "/";
}

// The areas a human would name. The top-level folder is right for most projects, but one that keeps
// nearly everything under a single folder drew as one colour: Stuff Downloader's map was "src" and
// "tests", which says nothing about where core ends and the GUI begins. So a folder holding more than
// 40% of the files is split into its subfolders, and again if one of those is still that big. Files
// sitting directly in a split folder stay in it.
export function mapGrouping(paths = []) {
  const clean = paths.map((file) => String(file).replace(/^\/+/, ""));
  const groupOf = new Map(clean.map((file) => [file, mapGroupOf(file)]));
  for (let round = 0; round < 4; round += 1) {
    const counts = new Map();
    for (const group of groupOf.values()) counts.set(group, (counts.get(group) || 0) + 1);
    let changed = false;
    for (const [group, size] of counts) {
      if (group === "/" || size < 12 || size / Math.max(1, clean.length) <= 0.4) continue;
      const deeper = (file) => {
        const rest = file.slice(group.length + 1);
        const cut = rest.indexOf("/");
        return cut > 0 ? `${group}/${rest.slice(0, cut)}` : group;
      };
      const members = clean.filter((file) => groupOf.get(file) === group);
      if (new Set(members.map(deeper)).size <= 1 && deeper(members[0]) === group) continue;
      for (const file of members) groupOf.set(file, deeper(file));
      changed = true;
    }
    if (!changed) break;
  }
  return groupOf;
}

// How an area is named on screen: the folder path without a leading src/ or lib/, which every file
// in a src-layout project would otherwise repeat.
export function mapGroupLabel(group = "") {
  if (group === "/") return "root files";
  return String(group).replace(/^(src|lib|source)\//, "") || group;
}

// Test files, by the conventions every ecosystem here uses. They double a project's file count and
// sit on top of the code they test, so the map can set them aside on request.
export function isTestPath(file = "") {
  const clean = String(file).replace(/\\/g, "/");
  return /(^|\/)(tests?|__tests__|spec|specs)\//i.test(clean)
    || /(^|\/)test_[^/]+\.py$/i.test(clean)
    || /_test\.(py|go|rs|ts|js)$/i.test(clean)
    || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(clean);
}

// A small deterministic hash, used to seed starting positions. The map must not reshuffle itself
// when the page re-renders: the same project has to produce the same picture every time, or nobody
// can build a memory of where things are.
function seedOf(value = "") {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

// A force-directed map of the project's files. Fruchterman-Reingold — repulsion between every pair,
// spring attraction along imports, a cooling schedule that stops it wandering — plus one extra
// force that pulls a file toward its folder's centre of mass, so the picture reads as regions
// rather than as one cloud.
//
// Deliberately dependency-free and synchronous: 310 nodes is ~48k pair computations a tick, which
// is a few hundred milliseconds of straight-line arithmetic over typed arrays. No layout worker, no
// d3, nothing to install — the same rule the dependency board already follows.
export function layoutCodeMap(map = {}, options = {}) {
  const width = Number(options.width) || 1000;
  const height = Number(options.height) || 700;
  const iterations = Number(options.iterations) || 220;
  const maxNodes = Number(options.maxNodes) || 1200;
  const labelCount = Number.isFinite(options.labelCount) ? Number(options.labelCount) : 14;
  const padding = Number(options.padding) || 26;

  const touchedBy = new Map((map.touched || []).map((entry) => [entry.file, Number(entry.count) || 0]));
  const notesBy = new Map();
  for (const note of map.notes || []) {
    for (const file of note.files || []) {
      if (!notesBy.has(file)) notesBy.set(file, []);
      notesBy.get(file).push(note);
    }
  }

  const degree = new Map();
  for (const edge of map.edges || []) {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  }
  // If a project ever outgrows the budget, the files nothing imports go first and the connected
  // core stays. Below the cap — which is every project measured so far — nothing is dropped.
  let modules = (map.modules || []).slice();
  let dropped = 0;
  if (modules.length > maxNodes) {
    const keep = modules.slice().sort((left, right) =>
      (touchedBy.has(right.path) ? 1 : 0) - (touchedBy.has(left.path) ? 1 : 0)
      || (notesBy.has(right.path) ? 1 : 0) - (notesBy.has(left.path) ? 1 : 0)
      || (degree.get(right.path) || 0) - (degree.get(left.path) || 0)
      || left.path.localeCompare(right.path)).slice(0, maxNodes);
    dropped = modules.length - keep.length;
    modules = keep.sort((left, right) => left.path.localeCompare(right.path));
  }
  if (!modules.length) return { width, height, nodes: [], edges: [], groups: [], dropped: 0 };

  const index = new Map(modules.map((module, position) => [module.path, position]));
  const links = (map.edges || [])
    .map((edge) => ({ source: index.get(edge.from), target: index.get(edge.to) }))
    .filter((link) => Number.isInteger(link.source) && Number.isInteger(link.target) && link.source !== link.target);

  const count = modules.length;
  const grouping = mapGrouping(modules.map((module) => module.path));
  const areaOf = (file) => grouping.get(String(file).replace(/^\/+/, "")) || mapGroupOf(file);
  const groups = [...new Set(modules.map((module) => areaOf(module.path)))].sort();
  const groupIndex = new Map(groups.map((name, position) => [name, position]));
  const groupOf = new Int32Array(count);
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const dx = new Float64Array(count);
  const dy = new Float64Array(count);

  // Folders start spread around an ellipse shaped like the box, and their files start near their
  // folder. A good starting guess is most of what keeps 220 iterations enough — and seeding to the
  // box's proportions is what stops a wide panel being filled by a circular blob with empty margins
  // down both sides.
  const radiusX = width * 0.32;
  const radiusY = height * 0.32;
  for (let node = 0; node < count; node += 1) {
    const group = groupIndex.get(areaOf(modules[node].path));
    groupOf[node] = group;
    const groupAngle = (group / Math.max(1, groups.length)) * Math.PI * 2;
    const seed = seedOf(modules[node].path);
    const angle = seed * Math.PI * 2;
    const spread = Math.sqrt(seed) * 0.5;
    x[node] = width / 2 + Math.cos(groupAngle) * radiusX + Math.cos(angle) * radiusX * spread;
    y[node] = height / 2 + Math.sin(groupAngle) * radiusY + Math.sin(angle) * radiusY * spread;
  }

  // A file's size on screen is how many other files touch it — that is the one thing a map can say
  // at a glance that a file tree cannot. It is measured in screen pixels and never scaled with the
  // fit, or a large project renders every hub at the same dot as every leaf.
  const radii = new Float64Array(count);
  for (let node = 0; node < count; node += 1) {
    radii[node] = Math.min(16, 3 + Math.sqrt(degree.get(modules[node].path) || 0) * 1.65);
  }
  const largest = Math.max(...radii);

  const area = width * height;
  // k is the distance at which files would sit if they were spread evenly over the panel; it sets
  // the strength of the repulsion. Imports then pull neighbours to a little over half of that, so
  // a folder reads as a group without becoming a blot.
  const k = Math.sqrt(area / count);
  const kSquared = k * k;
  const restLength = k * 0.55;
  const springStrength = 0.75;
  const linkCount = new Int32Array(count);
  for (const link of links) {
    linkCount[link.source] += 1;
    linkCount[link.target] += 1;
  }
  // How much room a file claims, scaled to how big it is drawn. Uniform repulsion gives a config
  // file nothing imports the same personal space as a 63-import hub, and since the unconnected
  // files have no springs holding them in, they end up flung into a perfect ring around everything
  // else — a shape that looks like an artifact of the drawing and carries no information. Charging
  // by radius settles them back among the files they sit beside on disk.
  const charge = new Float64Array(count);
  const meanRadius = radii.reduce((total, value) => total + value, 0) / count;
  for (let node = 0; node < count; node += 1) charge[node] = radii[node] / meanRadius;
  const groupX = new Float64Array(groups.length);
  const groupY = new Float64Array(groups.length);
  const groupSize = new Float64Array(groups.length);
  let temperature = Math.min(width, height) / 6;

  for (let step = 0; step < iterations; step += 1) {
    dx.fill(0);
    dy.fill(0);
    groupX.fill(0);
    groupY.fill(0);
    groupSize.fill(0);
    for (let node = 0; node < count; node += 1) {
      groupX[groupOf[node]] += x[node];
      groupY[groupOf[node]] += y[node];
      groupSize[groupOf[node]] += 1;
    }
    for (let group = 0; group < groups.length; group += 1) {
      if (!groupSize[group]) continue;
      groupX[group] /= groupSize[group];
      groupY[group] /= groupSize[group];
    }

    for (let left = 0; left < count; left += 1) {
      for (let right = left + 1; right < count; right += 1) {
        let deltaX = x[left] - x[right];
        let deltaY = y[left] - y[right];
        let distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        if (distance < 0.01) {
          // Two files on the same point would divide by zero. Nudge them apart by their index, so
          // the escape is deterministic rather than random.
          deltaX = ((left % 7) - 3) * 0.01 || 0.01;
          deltaY = ((right % 7) - 3) * 0.01 || 0.01;
          distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        }
        const force = (kSquared / distance) * charge[left] * charge[right];
        const unitX = (deltaX / distance) * force;
        const unitY = (deltaY / distance) * force;
        dx[left] += unitX;
        dy[left] += unitY;
        dx[right] -= unitX;
        dy[right] -= unitY;
      }
    }

    // An import is a spring with a rest length, not a rubber band that tightens without limit.
    // The textbook Fruchterman-Reingold attraction is d²/k per edge, which means a file imported
    // by forty others is pulled forty times and the whole neighbourhood collapses into a dot —
    // measured on this project's own data, a 37-file folder rendered about 70px across while
    // unconnected files were flung to the rim. Dividing by the smaller endpoint's degree is what
    // d3-force does and what keeps hubs from crushing everything attached to them.
    for (const link of links) {
      const deltaX = x[link.source] - x[link.target];
      const deltaY = y[link.source] - y[link.target];
      const distance = Math.max(0.01, Math.sqrt(deltaX * deltaX + deltaY * deltaY));
      const share = 1 / (1 + Math.min(linkCount[link.source], linkCount[link.target]));
      const force = (distance - restLength) * springStrength * share;
      const unitX = (deltaX / distance) * force;
      const unitY = (deltaY / distance) * force;
      dx[link.source] -= unitX;
      dy[link.source] -= unitY;
      dx[link.target] += unitX;
      dy[link.target] += unitY;
    }

    for (let node = 0; node < count; node += 1) {
      const group = groupOf[node];
      // Gentle enough that an area is a region rather than a knot: at 0.22 Stuff Downloader's core
      // and gui drew as two blots with a median gap of 14px between files; at 0.12 it is 29px.
      dx[node] += (groupX[group] - x[node]) * 0.12;
      dy[node] += (groupY[group] - y[node]) * 0.12;
      // Gravity pulls harder along the box's short side, so the picture ends up the shape of the
      // panel it has to live in rather than a circle with empty margins.
      // Areas with no imports between them (a worker process, packaging scripts) drift apart under
      // repulsion alone, and fitting that spread into the panel squeezed every area small. This much
      // gravity keeps them in one picture.
      dx[node] += (width / 2 - x[node]) * 0.05 * (height / width);
      dy[node] += (height / 2 - y[node]) * 0.05 * (width / height);
      const distance = Math.max(0.01, Math.sqrt(dx[node] * dx[node] + dy[node] * dy[node]));
      const limit = Math.min(distance, temperature) / distance;
      x[node] += dx[node] * limit;
      y[node] += dy[node] * limit;
    }
    temperature = Math.max(0.6, temperature * 0.965);
  }

  // Fit the simulated positions into the box they have to be drawn in, rather than clipping them.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let node = 0; node < count; node += 1) {
    minX = Math.min(minX, x[node]);
    minY = Math.min(minY, y[node]);
    maxX = Math.max(maxX, x[node]);
    maxY = Math.max(maxY, y[node]);
  }
  const inset = padding + largest;
  const usableWidth = Math.max(1, width - inset * 2);
  const usableHeight = Math.max(1, height - inset * 2);
  // Fit each axis to the panel, then pull the two scales back towards each other. A graph settles
  // into roughly a circle while the panel it is drawn in is a wide rectangle, so fitting on one
  // scale leaves half the width empty; fitting each axis on its own fills it but stretches the
  // shape. Allowing at most a 1.4:1 difference takes most of the space back while the picture
  // still reads as the shape the simulation found.
  let scaleX = usableWidth / Math.max(1, maxX - minX);
  let scaleY = usableHeight / Math.max(1, maxY - minY);
  const stretch = 1.4;
  if (scaleX > scaleY * stretch) scaleX = scaleY * stretch;
  if (scaleY > scaleX * stretch) scaleY = scaleX * stretch;
  const offsetX = inset + (usableWidth - (maxX - minX) * scaleX) / 2 - minX * scaleX;
  const offsetY = inset + (usableHeight - (maxY - minY) * scaleY) / 2 - minY * scaleY;
  for (let node = 0; node < count; node += 1) {
    x[node] = x[node] * scaleX + offsetX;
    y[node] = y[node] * scaleY + offsetY;
  }

  // Fitting a spring layout to a box compresses it, and a compressed cluster is a smudge: on this
  // project's own 310 files the dense folder arrived with 138 overlapping pairs and neighbours
  // 1.5px apart. So the last thing that happens is in screen pixels — push overlapping circles
  // apart until each one is visible, staying inside the frame. Positions only move locally, so the
  // shape the simulation found survives.
  const gap = 2.2;
  for (let pass = 0; pass < 60; pass += 1) {
    let moved = 0;
    for (let left = 0; left < count; left += 1) {
      for (let right = left + 1; right < count; right += 1) {
        const wanted = radii[left] + radii[right] + gap;
        let deltaX = x[right] - x[left];
        let deltaY = y[right] - y[left];
        let distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        if (distance >= wanted) continue;
        if (distance < 0.01) {
          deltaX = ((left % 5) - 2) || 1;
          deltaY = ((right % 5) - 2) || 1;
          distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        }
        const shift = (wanted - distance) / 2;
        const unitX = (deltaX / distance) * shift;
        const unitY = (deltaY / distance) * shift;
        x[left] -= unitX;
        y[left] -= unitY;
        x[right] += unitX;
        y[right] += unitY;
        moved += 1;
      }
    }
    for (let node = 0; node < count; node += 1) {
      x[node] = Math.min(width - padding - radii[node], Math.max(padding + radii[node], x[node]));
      y[node] = Math.min(height - padding - radii[node], Math.max(padding + radii[node], y[node]));
    }
    if (!moved) break;
  }

  // Labels go to the hubs, and to the files this task changed — the few nodes whose name is the
  // point. Everything else names itself on hover, which is what the ~290 remaining files need.
  //
  // A label that lands on top of another label is worse than no label, and the dense middle of a
  // real project is exactly where they collide. So candidates are taken in priority order — the
  // task's own files first, then the biggest hubs — and one is dropped when its text box would
  // overlap a box already kept.
  const position = new Map(modules.map((module, node) => [module.path, node]));
  const candidates = modules.slice()
    .sort((left, right) =>
      (touchedBy.has(right.path) ? 1 : 0) - (touchedBy.has(left.path) ? 1 : 0)
      || (degree.get(right.path) || 0) - (degree.get(left.path) || 0)
      || left.path.localeCompare(right.path))
    .slice(0, Math.max(0, labelCount) + touchedBy.size);
  const labelled = new Set();
  const boxes = [];
  for (const module of candidates) {
    const node = position.get(module.path);
    const name = module.path.slice(module.path.lastIndexOf("/") + 1);
    // 5.2px per character approximates the 9.5px label face closely enough to keep boxes apart.
    const halfWidth = Math.max(14, name.length * 2.6);
    const centreY = y[node] - radii[node] - 9;
    const box = { left: x[node] - halfWidth, right: x[node] + halfWidth, top: centreY - 6, bottom: centreY + 6 };
    if (boxes.some((kept) => box.left < kept.right && box.right > kept.left && box.top < kept.bottom && box.bottom > kept.top)) continue;
    boxes.push(box);
    labelled.add(module.path);
  }

  const nodes = modules.map((module, node) => ({
    path: module.path,
    name: module.path.slice(module.path.lastIndexOf("/") + 1),
    language: module.language || "",
    loc: Number(module.loc) || 0,
    summary: module.summary || "",
    group: groups[groupOf[node]],
    groupIndex: groupOf[node],
    degree: degree.get(module.path) || 0,
    touched: touchedBy.get(module.path) || 0,
    notes: notesBy.get(module.path) || [],
    labelled: labelled.has(module.path),
    x: x[node],
    y: y[node],
    r: radii[node],
  }));
  const positioned = new Map(nodes.map((node) => [node.path, node]));
  const edges = links.map((link) => {
    const source = positioned.get(modules[link.source].path);
    const target = positioned.get(modules[link.target].path);
    return {
      from: source.path,
      to: target.path,
      x1: source.x,
      y1: source.y,
      x2: target.x,
      y2: target.y,
      live: Boolean(source.touched || target.touched),
    };
  });
  const areas = groups.map((name, position) => {
      const members = nodes.filter((node) => node.groupIndex === position);
      // Where the area's name is written: above the middle of its files, so the map reads as
      // regions with names rather than a field of dots.
      const centreX = members.reduce((total, node) => total + node.x, 0) / Math.max(1, members.length);
      const top = Math.min(...members.map((node) => node.y - node.r));
      return {
        name,
        label: mapGroupLabel(name),
        index: position,
        count: members.length,
        touched: members.filter((node) => node.touched).length,
        labelX: centreX,
        labelY: Math.max(14, top - 10),
      };
  });
  // Two areas side by side put their names on the same line. Walk them top to bottom and lift a name
  // above any name it would print over — 6.4px a character approximates the 11px area face.
  const placedNames = [];
  for (const area of areas.slice().sort((left, right) => left.labelY - right.labelY || left.labelX - right.labelX)) {
    const half = Math.max(20, area.label.length * 3.2);
    let y = area.labelY;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const clash = placedNames.find((box) => area.labelX - half < box.right && area.labelX + half > box.left && y - 11 < box.bottom && y + 3 > box.top);
      if (!clash) break;
      y = clash.top - 4;
    }
    area.labelY = Math.max(12, y);
    placedNames.push({ left: area.labelX - half, right: area.labelX + half, top: area.labelY - 11, bottom: area.labelY + 3 });
  }
  return {
    width,
    height,
    nodes,
    edges,
    dropped,
    groups: areas,
  };
}

// ---- The work board as a flowchart of how the work went ------------------------------------------
//
// The board used to draw every card the database held, where the dependency graph put it. On a real
// task that meant 21 cards for three pieces of work: a review for every round, a "Resolve blocker"
// card for every blocked report, a "(replacement)" copy for every card nobody could reopen, and the
// dead originals drawn brightest of all. The owner asked for a flowchart they can trust at a glance,
// so the board now draws *steps*: a piece of work with its review directly underneath it, in the
// order the work happened. Rounds and send-backs are drawn on the step instead of as more cards, and
// everything that is no longer part of the flow — closed, replaced, decided, or left blocked on a
// finished task — is folded into a "set aside" list, so nothing disappears without a trace.

const FLOW_FINISHED = new Set(["accepted", "cancelled"]);
const isPlanCard = (card) => Boolean(Number(card.plans)) || card.role === "planner";
const isReviewCard = (card) => Boolean(Number(card.verifies)) || card.role === "reviewer";
const openStatus = (card) => ["queued", "claimed", "blocked"].includes(card.status);
const createdMs = (card) => Date.parse(card.created_at ?? "");

export function buildFlowModel(assignments = [], { taskStatus = null } = {}) {
  const finished = FLOW_FINISHED.has(taskStatus);
  const byId = new Map(assignments.map((card) => [String(card.id), card]));
  const setAside = [];
  const hidden = new Set();
  const decisions = new Map();
  const hide = (card, reason) => { hidden.add(String(card.id)); setAside.push({ card, reason }); };

  for (const card of assignments) {
    const resolves = card.resolves_assignment_id ? String(card.resolves_assignment_id) : null;
    if (resolves || /^resolve blocker:/i.test(String(card.title || ""))) {
      if (resolves) decisions.set(resolves, card);
      hide(card, resolves && byId.has(resolves) ? `Decision on “${byId.get(resolves).title}”` : "Decision on a blocked card");
      continue;
    }
    if (card.status === "closed") {
      hide(card, card.replaced_by_assignment_id && byId.has(String(card.replaced_by_assignment_id))
        ? `Replaced by “${byId.get(String(card.replaced_by_assignment_id)).title}”`
        : (card.closed_reason ? `Closed: ${card.closed_reason}` : "Closed"));
      continue;
    }
    if (card.status === "blocked" && card.replaced_by_assignment_id && byId.has(String(card.replaced_by_assignment_id))) {
      hide(card, `Replaced by “${byId.get(String(card.replaced_by_assignment_id)).title}”`);
      continue;
    }
    if (card.status === "blocked" && finished) hide(card, "Left blocked when the task finished");
  }

  // Where a reference to a card lands on the board: the card itself, what replaced it, or nowhere.
  const visibleFor = (id, seen = new Set()) => {
    const key = String(id);
    if (!byId.has(key) || seen.has(key)) return null;
    if (!hidden.has(key)) return key;
    seen.add(key);
    const replacement = byId.get(key).replaced_by_assignment_id;
    return replacement ? visibleFor(replacement, seen) : null;
  };

  // A review sits under the work it reviews. Several visible reviews of one piece of work are rounds
  // of one review: the open one (or the latest) is drawn, the earlier ones are its history.
  const reviewGroups = new Map();
  for (const card of assignments) {
    if (hidden.has(String(card.id)) || !isReviewCard(card) || !card.review_subject_assignment_id) continue;
    const subject = visibleFor(card.review_subject_assignment_id);
    if (!subject || isReviewCard(byId.get(subject))) continue;
    if (!reviewGroups.has(subject)) reviewGroups.set(subject, []);
    reviewGroups.get(subject).push(card);
  }
  const reviewOf = new Map();
  const stepOfCard = new Map();
  for (const [subject, group] of reviewGroups) {
    group.sort((left, right) => createdMs(left) - createdMs(right));
    const drawn = group.find(openStatus) || group[group.length - 1];
    const history = group.filter((card) => card !== drawn);
    const rounds = Math.max(Number(drawn.review_round) || 1, group.length);
    reviewOf.set(subject, { card: drawn, rounds, history });
    for (const card of group) stepOfCard.set(String(card.id), subject);
  }

  const steps = [];
  for (const card of assignments) {
    const id = String(card.id);
    if (hidden.has(id) || stepOfCard.has(id)) continue;
    stepOfCard.set(id, id);
    const review = reviewOf.get(id) || null;
    const reworks = Number(card.rework_count) || 0;
    steps.push({
      id,
      main: card,
      review: review?.card || null,
      rounds: review?.rounds || 0,
      history: review?.history || [],
      // How many times this piece of work went back and forth — the loop drawn on the step.
      sentBack: Math.max(reworks, review ? review.rounds - 1 : 0),
      decision: decisions.get(id) || null,
      plan: isPlanCard(card),
      createdAt: card.created_at,
      dependsOn: [],
    });
  }
  const stepIds = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    const declared = [...(step.main.dependsOn || []), ...(step.review?.dependsOn || [])];
    const targets = new Set();
    for (const dependency of declared) {
      const visible = visibleFor(dependency);
      const target = visible ? stepOfCard.get(visible) : null;
      if (target && target !== step.id && stepIds.has(target)) targets.add(target);
    }
    step.dependsOn = [...targets];
  }
  return { steps, setAside };
}

export function layoutFlowBoard(model, options = {}) {
  const cardWidth = Number(options.cardWidth) || 236;
  const cardHeight = Number(options.cardHeight) || 80;
  const pairGap = Number(options.pairGap) || 28;
  const columnGap = Number(options.columnGap) || 44;
  const rowGap = Number(options.rowGap) || 60;
  const padding = Number(options.padding) || 20;
  const gutter = Number(options.gutter) || 92;
  const parallelWindowMs = Number.isFinite(options.parallelWindowMs) ? options.parallelWindowMs : 90_000;
  const steps = model?.steps || [];
  if (!steps.length) return { width: 0, height: 0, rows: [], nodes: [], edges: [] };

  const byId = new Map(steps.map((step, index) => [step.id, { step, index }]));
  const time = (step) => Date.parse(step.createdAt ?? "");
  const sameBurst = (earlier, later) => {
    const gap = time(later) - time(earlier);
    return Number.isFinite(gap) && gap >= 0 && gap <= parallelWindowMs;
  };
  // Depth follows declared order. A step that declared none goes under the step created before it —
  // the order the work actually happened in — unless it was planned in the same burst as that step,
  // in which case the two ran side by side. Each step remembers what it hangs from, so the board can
  // draw that "then" as a quiet connector rather than leave the step floating.
  const depth = new Map();
  const anchors = new Map();
  const visiting = new Set();
  const depthOf = (step) => {
    if (depth.has(step.id)) return depth.get(step.id);
    if (visiting.has(step.id)) return 0;
    visiting.add(step.id);
    const index = byId.get(step.id).index;
    const previous = index > 0 ? steps[index - 1] : null;
    let value = 0;
    let hangs = { ids: [], type: "dependency" };
    const declared = step.dependsOn.map((id) => byId.get(id)?.step).filter(Boolean);
    if (declared.length) {
      value = Math.max(...declared.map((dependency) => depthOf(dependency) + 1));
      hangs = { ids: declared.map((dependency) => dependency.id), type: "dependency" };
    } else if (previous && !step.plan && !previous.plan && !previous.dependsOn.length && sameBurst(previous, step)) {
      value = depthOf(previous);
      hangs = { ...(anchors.get(previous.id) || { ids: [], type: "sequence" }), type: "sequence" };
    } else if (previous) {
      value = depthOf(previous) + 1;
      hangs = { ids: [previous.id], type: "sequence" };
    }
    visiting.delete(step.id);
    depth.set(step.id, value);
    anchors.set(step.id, hangs);
    return value;
  };
  for (const step of steps) depthOf(step);

  const rowCount = Math.max(...steps.map((step) => depth.get(step.id))) + 1;
  const rows = Array.from({ length: rowCount }, () => []);
  for (const step of steps) rows[depth.get(step.id)].push(step);
  const stepHeight = (step) => (step.review ? cardHeight * 2 + pairGap : cardHeight);
  const rowWidth = (row) => row.length * cardWidth + Math.max(0, row.length - 1) * columnGap;
  const contentWidth = Math.max(...rows.map(rowWidth));

  // Order each row under what it hangs from, so arrows run down rather than across.
  const slot = new Map();
  const nodes = [];
  const placed = new Map();
  const rowBoxes = [];
  let y = padding;
  rows.forEach((row, rowIndex) => {
    row.sort((left, right) => {
      const centre = (step) => {
        const positions = (anchors.get(step.id)?.ids || []).map((id) => slot.get(id)).filter(Number.isFinite);
        return positions.length ? positions.reduce((sum, value) => sum + value, 0) / positions.length : byId.get(step.id).index;
      };
      return centre(left) - centre(right) || byId.get(left.id).index - byId.get(right.id).index;
    });
    const left = gutter + padding + (contentWidth - rowWidth(row)) / 2;
    const height = Math.max(...row.map(stepHeight));
    row.forEach((step, position) => {
      const x = left + position * (cardWidth + columnGap);
      slot.set(step.id, x);
      const main = { id: String(step.main.id), stepId: step.id, kind: "main", card: step.main, x, y, width: cardWidth, height: cardHeight };
      nodes.push(main);
      let last = main;
      if (step.review) {
        const review = { id: String(step.review.id), stepId: step.id, kind: "review", card: step.review, rounds: step.rounds, history: step.history, x, y: y + cardHeight + pairGap, width: cardWidth, height: cardHeight };
        nodes.push(review);
        last = review;
      }
      placed.set(step.id, { step, main, last });
    });
    const stamps = row.map(time).filter(Number.isFinite);
    rowBoxes.push({
      index: rowIndex,
      y,
      height,
      label: row.every((step) => step.plan) ? "Plan" : null,
      startedAt: stamps.length ? new Date(Math.min(...stamps)).toISOString() : null,
    });
    y += height + rowGap;
  });
  let stepNumber = 0;
  for (const row of rowBoxes) {
    if (!row.label) { stepNumber += 1; row.label = `Step ${stepNumber}`; }
  }

  const edges = [];
  for (const { step, main, last } of placed.values()) {
    if (step.review) {
      const x = main.x + cardWidth / 2;
      edges.push({ id: `pair:${step.id}`, type: "pair", sourceId: main.id, targetId: last.id, path: `M ${x} ${main.y + cardHeight} L ${x} ${last.y}` });
    }
    if (step.sentBack > 0) {
      // The send-back loop: out of the review's right edge, up, and back into the work's right edge.
      const from = step.review ? last : main;
      const x1 = from.x + cardWidth;
      const y1 = from.y + cardHeight / 2;
      const y2 = main.y + cardHeight / 2 + (step.review ? 0 : -18);
      const bulge = 30;
      edges.push({
        id: `rework:${step.id}`, type: "rework", sourceId: from.id, targetId: main.id,
        path: step.review
          ? `M ${x1} ${y1} C ${x1 + bulge} ${y1}, ${x1 + bulge} ${y2}, ${x1} ${y2}`
          : `M ${x1} ${y1 + 12} C ${x1 + bulge} ${y1 + 12}, ${x1 + bulge} ${y2}, ${x1} ${y2}`,
        label: `sent back ${step.sentBack}×`,
        labelX: x1 + bulge + 4,
        labelY: (y1 + y2) / 2 + 4,
      });
    }
    const hangs = anchors.get(step.id);
    for (const sourceId of hangs?.ids || []) {
      const source = placed.get(sourceId);
      if (!source) continue;
      const x1 = source.last.x + cardWidth / 2;
      const y1 = source.last.y + cardHeight;
      const x2 = main.x + cardWidth / 2;
      const y2 = main.y;
      const bend = Math.max(18, (y2 - y1) / 2);
      edges.push({
        id: `${hangs.type}:${sourceId}:${step.id}`, type: hangs.type, sourceId: source.last.id, targetId: main.id,
        path: `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`,
      });
    }
  }

  return {
    width: gutter + padding * 2 + contentWidth + 90,
    height: y - rowGap + padding,
    rows: rowBoxes,
    nodes,
    edges,
  };
}

function renderInline(value = "") {
  const source = String(value);
  const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/gi;
  let result = "";
  let cursor = 0;
  for (const match of source.matchAll(tokenPattern)) {
    result += escapeHtml(source.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      result += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
    } else if (token.startsWith("**")) {
      result += `<strong>${escapeHtml(token.slice(2, -2))}</strong>`;
    } else {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/i);
      try {
        const url = new URL(link[2]);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error("unsupported link");
        result += `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link[1])}</a>`;
      } catch {
        result += escapeHtml(token);
      }
    }
    cursor = match.index + token.length;
  }
  return result + escapeHtml(source.slice(cursor));
}

// A deliberately small, allow-listed Markdown renderer. Every text fragment is escaped before
// markup is introduced, and links are limited to parsed HTTP(S) URLs.
export function renderSafeMarkdown(value = "") {
  const lines = String(value).replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let list = null;
  let code = null;
  let codeLanguage = "";
  const closeList = () => {
    if (!list) return;
    output.push(`</${list}>`);
    list = null;
  };
  const openList = (type) => {
    if (list === type) return;
    closeList();
    list = type;
    output.push(`<${type}>`);
  };
  const closeCode = () => {
    if (code === null) return;
    const className = codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : "";
    output.push(`<pre><code${className}>${escapeHtml(code.join("\n"))}</code></pre>`);
    code = null;
    codeLanguage = "";
  };

  for (const line of lines) {
    const fence = line.match(/^```([a-z0-9_-]{0,30})\s*$/i);
    if (fence) {
      closeList();
      if (code === null) {
        code = [];
        codeLanguage = fence[1] || "";
      } else {
        closeCode();
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length + 2;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    const checkbox = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (checkbox) {
      openList("ul");
      output.push(`<li class="task-list-line"><input type="checkbox" disabled ${checkbox[1].toLowerCase() === "x" ? "checked " : ""}aria-hidden="true">${renderInline(checkbox[2])}</li>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      openList("ul");
      output.push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }
    const numbered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (numbered) {
      openList("ol");
      output.push(`<li>${renderInline(numbered[1])}</li>`);
      continue;
    }
    closeList();
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      output.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
    } else if (!line) {
      output.push(`<div class="message-blank" aria-hidden="true"></div>`);
    } else {
      output.push(`<div class="message-line">${renderInline(line)}</div>`);
    }
  }
  closeList();
  closeCode();
  return output.join("");
}

export function unreadTimelineCount(events = [], lastReadId = 0) {
  const marker = Number(lastReadId) || 0;
  return events.filter((event) => event.agent_id && Number(event.id) > marker).length;
}

// The banner copy for a blocked task. Kept out of the DOM code so the one sentence a stuck human
// reads is testable: this is the wording that replaces a Resume button buried ~4,800px down the
// team panel, where it went unfound for a whole session.
// What each kind of blocker means, in the words the human needs rather than the token the agent
// sent. Blocks recorded before kinds existed carry none, and say nothing rather than guessing.
const BLOCK_KIND_COPY = {
  "needs-human": "needs a decision only you can make",
  "over-my-head": "beyond the model or effort the agent had",
  misrouted: "the work could not correctly go to that agent",
  external: "waiting on something outside the project",
};

export function blockedBannerCopy(recovery = null) {
  if (!recovery) return null;
  const reason = String(recovery.reason || "").trim();
  const who = recovery.blockedBy ? `Blocked by ${recovery.blockedBy}` : "Blocked";
  const kind = BLOCK_KIND_COPY[recovery.kind] || null;
  const stranded = Number(recovery.strandedAssignments) || 0;
  const parts = [kind ? `${who} — ${kind}` : who];
  if (stranded) parts.push(`${stranded} assignment${stranded === 1 ? "" : "s"} stopped mid-flight`);
  parts.push(`v${recovery.version}`);
  return {
    reason: reason || "No reason was recorded.",
    meta: `${parts.join(" · ")} — agents cannot lift this; resuming reopens the task at v${Number(recovery.version) + 1} and clears its approvals.`,
    targets: Array.isArray(recovery.resumableBy) ? recovery.resumableBy : [],
  };
}
