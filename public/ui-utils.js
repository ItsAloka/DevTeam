export function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

// What the board says about itself when it is collapsed to one line. Blocked work and requested
// changes come first: they are the reasons a human would open the board at all.
export function boardSummary(assignments = []) {
  if (!assignments.length) return "Waiting for the plan";
  const count = (predicate) => assignments.filter(predicate).length;
  const blocked = count((item) => item.status === "blocked");
  const rework = count((item) => Number(item.rework_count) > 0 || Boolean(item.rework_requested_at));
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
// is the old queue again, in one line.
export function currentWork(assignments = [], limit = 3) {
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
  const groups = [...new Set(modules.map((module) => mapGroupOf(module.path)))].sort();
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
    const group = groupIndex.get(mapGroupOf(modules[node].path));
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
      dx[node] += (groupX[group] - x[node]) * 0.22;
      dy[node] += (groupY[group] - y[node]) * 0.22;
      // Gravity pulls harder along the box's short side, so the picture ends up the shape of the
      // panel it has to live in rather than a circle with empty margins.
      dx[node] += (width / 2 - x[node]) * 0.012 * (height / width);
      dy[node] += (height / 2 - y[node]) * 0.012 * (width / height);
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
  return {
    width,
    height,
    nodes,
    edges,
    dropped,
    groups: groups.map((name, position) => ({
      name,
      index: position,
      count: nodes.filter((node) => node.groupIndex === position).length,
      touched: nodes.filter((node) => node.groupIndex === position && node.touched).length,
    })),
  };
}

export function layoutAssignmentBoard(assignments = [], options = {}) {
  const nodeWidth = Number(options.nodeWidth) || 208;
  const nodeHeight = Number(options.nodeHeight) || 86;
  const siblingGap = Number(options.siblingGap) || 26;
  const layerGap = Number(options.layerGap) || 46;
  const padding = Number(options.padding) || 16;
  const gutter = Number(options.gutter) || 104;
  const items = assignments.map((assignment, index) => ({ assignment, index, id: String(assignment.id) }));
  if (!items.length) return { width: 0, height: 0, lanes: [], nodes: [], edges: [] };

  const byId = new Map(items.map((item) => [item.id, item]));
  // A review cannot start before the work it checks, so its subject places it like a dependency
  // even when the planner never declared one. Otherwise the review falls into creation order and
  // parallel reviews stack in one column under unrelated work.
  const placedAfter = (assignment) => [...new Set([
    ...(assignment.dependsOn || []),
    ...(assignment.review_subject_assignment_id ? [assignment.review_subject_assignment_id] : []),
  ].map(String))];
  const depthMemo = new Map();
  const visiting = new Set();
  // Most notes carry no recorded dependency — in this project's own history, 69% of them — because
  // a room adds work one piece at a time as it learns what is needed, not as one declared graph.
  // Laid out literally, every one of those is a root, and a task that ran twenty steps deep renders
  // as one twenty-note row. So a note with no dependency is placed under the note created before
  // it: that is the order the work actually happened in, and it keeps the board growing downward.
  // A note that does declare dependencies still sits exactly where they put it, which is what makes
  // a real parallel fan-out show up as a row.
  //
  // The exception is a planning burst. Notes created within `parallelWindowMs` of each other were
  // laid out in one go, and with no dependency between them the scheduler runs them side by side,
  // so the board does too: an undeclared note in a burst sits beside the latest undeclared note of
  // that burst (or beside the note just before it, when the burst has none). A planner note is a
  // turn in the work, not part of a burst: what follows it was produced by it and goes underneath.
  // Notes without a timestamp never form a burst.
  const parallelWindowMs = Number.isFinite(options.parallelWindowMs) ? options.parallelWindowMs : 90_000;
  const createdAt = (item) => Date.parse(item.assignment.created_at ?? "");
  const plans = (item) => Boolean(Number(item.assignment.plans)) || item.assignment.role === "planner";
  const sameBurst = (earlier, later) => {
    const gap = createdAt(later) - createdAt(earlier);
    return Number.isFinite(gap) && gap >= 0 && gap <= parallelWindowMs;
  };
  const burstPeer = (item) => {
    const previous = items[item.index - 1];
    if (plans(item) || !previous || plans(previous) || !sameBurst(previous, item)) return null;
    for (let index = item.index - 1; index >= 0 && !plans(items[index]); index -= 1) {
      if (!placedAfter(items[index].assignment).length) return items[index];
      if (index === 0 || !sameBurst(items[index - 1], items[index])) break;
    }
    return previous;
  };
  const depthOf = (item) => {
    if (depthMemo.has(item.id)) return depthMemo.get(item.id);
    // Assignment dependencies are a DAG. Treating a corrupt cycle as a root keeps the dashboard
    // usable enough to expose the bad rows instead of recursing until the whole room disappears.
    if (visiting.has(item.id)) return 0;
    visiting.add(item.id);
    const predecessors = placedAfter(item.assignment).map((id) => byId.get(id)).filter(Boolean);
    const previous = item.index > 0 ? items[item.index - 1] : null;
    const peer = predecessors.length ? null : burstPeer(item);
    let depth = 0;
    if (predecessors.length) depth = Math.max(...predecessors.map((dependency) => depthOf(dependency) + 1));
    else if (peer) depth = depthOf(peer);
    else if (previous) depth = depthOf(previous) + 1;
    visiting.delete(item.id);
    depthMemo.set(item.id, depth);
    return depth;
  };
  const maxDepth = Math.max(...items.map(depthOf));
  const layers = Array.from({ length: maxDepth + 1 }, () => []);
  for (const item of items) layers[depthOf(item)].push(item);

  // Barycentric passes preserve creation order when there is no crossing to remove. That stability
  // matters on a live board: a heartbeat should not make unrelated notes trade places.
  for (let pass = 0; pass < 2; pass += 1) {
    const priorPositions = new Map(layers.flatMap((layer) => layer.map((item, index) => [item.id, index])));
    for (let depth = 1; depth < layers.length; depth += 1) {
      layers[depth].sort((left, right) => {
        const barycenter = (item) => {
          const positions = placedAfter(item.assignment).map((id) => priorPositions.get(id)).filter(Number.isFinite);
          return positions.length ? positions.reduce((sum, value) => sum + value, 0) / positions.length : item.index;
        };
        return barycenter(left) - barycenter(right) || left.index - right.index || left.id.localeCompare(right.id);
      });
    }
    const nextPositions = new Map(layers.flatMap((layer) => layer.map((item, index) => [item.id, index])));
    for (let depth = layers.length - 2; depth >= 0; depth -= 1) {
      layers[depth].sort((left, right) => {
        const barycenter = (item) => {
          const positions = items
            .filter((candidate) => placedAfter(candidate.assignment).includes(item.id))
            .map((candidate) => nextPositions.get(candidate.id))
            .filter(Number.isFinite);
          return positions.length ? positions.reduce((sum, value) => sum + value, 0) / positions.length : item.index;
        };
        return barycenter(left) - barycenter(right) || left.index - right.index || left.id.localeCompare(right.id);
      });
    }
  }

  // Depth runs down the page, siblings spread across it. Work is read the way it is done — the
  // plan at the top, what it unblocked underneath — and a wide graph now costs vertical scroll,
  // which a screen has, instead of horizontal scroll, which it does not.
  const widestLayer = Math.max(...layers.map((layer) => layer.length));
  const contentWidth = widestLayer * nodeWidth + Math.max(0, widestLayer - 1) * siblingGap;
  const nodes = [];
  for (let depth = 0; depth < layers.length; depth += 1) {
    const layer = layers[depth];
    const layerWidth = layer.length * nodeWidth + Math.max(0, layer.length - 1) * siblingGap;
    const left = gutter + padding + (contentWidth - layerWidth) / 2;
    layer.forEach((item, slot) => nodes.push({
      id: item.id,
      depth,
      slot,
      x: left + slot * (nodeWidth + siblingGap),
      y: padding + depth * (nodeHeight + layerGap),
      width: nodeWidth,
      height: nodeHeight,
    }));
  }
  const positioned = new Map(nodes.map((node) => [node.id, node]));
  const edges = [];
  for (const item of items) {
    const target = positioned.get(item.id);
    for (const dependencyId of item.assignment.dependsOn || []) {
      const source = positioned.get(String(dependencyId));
      if (!source || !target) continue;
      const x1 = source.x + source.width / 2;
      const y1 = source.y + source.height;
      const x2 = target.x + target.width / 2;
      const y2 = target.y;
      const bend = Math.max(20, (y2 - y1) / 2);
      edges.push({
        id: `dependency:${source.id}:${target.id}`,
        type: "dependency",
        sourceId: source.id,
        targetId: target.id,
        path: `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`,
      });
    }
    // The review arrow points back up at what is being reviewed, bowing out to the left so it never
    // hides under the dependency arrow running the other way between the same two notes.
    const subject = positioned.get(String(item.assignment.review_subject_assignment_id || ""));
    if (subject && target) {
      const x1 = target.x;
      const y1 = target.y + target.height / 2;
      const x2 = subject.x;
      const y2 = subject.y + subject.height / 2;
      const lift = Math.max(34, Math.abs(y1 - y2) * 0.35);
      edges.push({
        id: `review:${target.id}:${subject.id}`,
        type: "review",
        sourceId: target.id,
        targetId: subject.id,
        path: `M ${x1} ${y1} C ${x1 - lift} ${y1}, ${x2 - lift} ${y2}, ${x2} ${y2}`,
      });
    }
  }
  const lanes = layers.map((layer, depth) => ({
    depth,
    y: padding + depth * (nodeHeight + layerGap),
    height: nodeHeight,
    label: [...new Set(layer.map((item) => String(item.assignment.role || "work")))].join(" / "),
  }));
  return {
    width: gutter + padding * 2 + contentWidth,
    height: padding * 2 + layers.length * nodeHeight + Math.max(0, layers.length - 1) * layerGap,
    lanes,
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
