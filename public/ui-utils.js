export function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
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

export function layoutAssignmentBoard(assignments = [], options = {}) {
  const nodeWidth = Number(options.nodeWidth) || 176;
  const nodeHeight = Number(options.nodeHeight) || 92;
  const columnGap = Number(options.columnGap) || 48;
  const rowGap = Number(options.rowGap) || 22;
  const padding = Number(options.padding) || 14;
  const headerHeight = Number(options.headerHeight) || 30;
  const items = assignments.map((assignment, index) => ({ assignment, index, id: String(assignment.id) }));
  if (!items.length) return { width: 0, height: 0, lanes: [], nodes: [], edges: [] };

  const byId = new Map(items.map((item) => [item.id, item]));
  const depthMemo = new Map();
  const visiting = new Set();
  const depthOf = (item) => {
    if (depthMemo.has(item.id)) return depthMemo.get(item.id);
    // Assignment dependencies are a DAG. Treating a corrupt cycle as a root keeps the dashboard
    // usable enough to expose the bad rows instead of recursing until the whole room disappears.
    if (visiting.has(item.id)) return 0;
    visiting.add(item.id);
    const predecessors = (item.assignment.dependsOn || []).map((id) => byId.get(String(id))).filter(Boolean);
    const depth = predecessors.length ? Math.max(...predecessors.map((dependency) => depthOf(dependency) + 1)) : 0;
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
          const positions = (item.assignment.dependsOn || []).map((id) => priorPositions.get(String(id))).filter(Number.isFinite);
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
            .filter((candidate) => (candidate.assignment.dependsOn || []).map(String).includes(item.id))
            .map((candidate) => nextPositions.get(candidate.id))
            .filter(Number.isFinite);
          return positions.length ? positions.reduce((sum, value) => sum + value, 0) / positions.length : item.index;
        };
        return barycenter(left) - barycenter(right) || left.index - right.index || left.id.localeCompare(right.id);
      });
    }
  }

  const largestLayer = Math.max(...layers.map((layer) => layer.length));
  const contentHeight = largestLayer * nodeHeight + Math.max(0, largestLayer - 1) * rowGap;
  const nodes = [];
  for (let depth = 0; depth < layers.length; depth += 1) {
    const layer = layers[depth];
    const layerHeight = layer.length * nodeHeight + Math.max(0, layer.length - 1) * rowGap;
    const top = headerHeight + padding + (contentHeight - layerHeight) / 2;
    layer.forEach((item, row) => nodes.push({
      id: item.id,
      depth,
      row,
      x: padding + depth * (nodeWidth + columnGap),
      y: top + row * (nodeHeight + rowGap),
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
      const x1 = source.x + source.width;
      const y1 = source.y + source.height / 2;
      const x2 = target.x;
      const y2 = target.y + target.height / 2;
      const bend = Math.max(20, (x2 - x1) / 2);
      edges.push({
        id: `dependency:${source.id}:${target.id}`,
        type: "dependency",
        sourceId: source.id,
        targetId: target.id,
        path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      });
    }
    const subject = positioned.get(String(item.assignment.review_subject_assignment_id || ""));
    if (subject && target) {
      const x1 = target.x;
      const y1 = target.y + target.height / 2;
      const x2 = subject.x + subject.width;
      const y2 = subject.y + subject.height / 2;
      const lift = Math.max(28, Math.abs(x1 - x2) * 0.18);
      edges.push({
        id: `review:${target.id}:${subject.id}`,
        type: "review",
        sourceId: target.id,
        targetId: subject.id,
        path: `M ${x1} ${y1} C ${x1 - lift} ${y1 - lift}, ${x2 + lift} ${y2 - lift}, ${x2} ${y2}`,
      });
    }
  }
  const lanes = layers.map((layer, depth) => ({
    depth,
    x: padding + depth * (nodeWidth + columnGap),
    width: nodeWidth,
    label: [...new Set(layer.map((item) => String(item.assignment.role || "work")))].join(" / "),
  }));
  return {
    width: padding * 2 + layers.length * nodeWidth + Math.max(0, layers.length - 1) * columnGap,
    height: headerHeight + padding * 2 + contentHeight,
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

export function timelineCategory(event = {}) {
  const type = String(event.type || "");
  if (type === "human.message" || type === "agent.message" || type === "agent.question") return "chat";
  if (type === "agent.finding" || type.includes("blocked") || type.includes("failed")) return "findings";
  if (type === "agent.decision") return "decisions";
  if (type === "agent.progress" || type === "agent.report" || type.startsWith("assignment.")) return "work";
  return "system";
}

export function eventMatchesTimelineFilter(event, filter = "all") {
  return filter === "all" || timelineCategory(event) === filter;
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
