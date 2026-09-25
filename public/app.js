import { agentColorIndex, blockedBannerCopy, boardSummary, buildFlowModel, currentWork, escapeHtml, isTestPath, layoutCodeMap, layoutFlowBoard, renderSafeMarkdown, unreadTimelineCount } from "/ui-utils.js";

const $ = (selector) => document.querySelector(selector);
const time = (stamp) => new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(stamp));
const relativeTime = (stamp) => {
  if (!stamp) return "";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(stamp).getTime()) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};
// The server reaps agents after 120s without a heartbeat; colour the pulse as it ages.
const freshness = (stamp) => {
  const seconds = (Date.now() - new Date(stamp).getTime()) / 1000;
  if (seconds < 60) return "fresh";
  if (seconds < 120) return "stale";
  return "cold";
};
// Agent names are agent-chosen, so the result is HTML-escaped: callers interpolate it into markup.
const initials = (name) => escapeHtml(String(name || "AI").trim().split(/\s+/).map((part) => [...part][0] || "").slice(0, 2).join("").toUpperCase());
// Only the software defaults get a nicer present-participle label; a project that defines its own
// vocabulary falls back to the role name itself, which reads fine ("Ana · fact-checker").
const ROLE_VERB = { planner: "planning", implementer: "implementing", reviewer: "reviewing", "security-reviewer": "security review", tester: "testing", researcher: "researching" };

// The roles the selected task's project defines. Populated from the task payload so the dropdown
// offers this project's vocabulary rather than a list of job titles baked into the HTML.
// Checks that used to pass and now do not, with who is suspected. Shown above the assignment list
// because a broken shared check is the team's problem, not one assignment's.
function renderRegressions(task) {
  const container = $("#regressions");
  if (!container) return;
  const open = task.regressions || [];
  container.classList.toggle("hidden", open.length === 0);
  if (!open.length) { container.innerHTML = ""; return; }
  container.innerHTML = `<div class="section-label">Broken checks</div>` + open.map((regression) => {
    const suspects = (regression.suspects || []).map((suspect) => `${escapeHtml(suspect.title)}${suspect.author ? ` · ${escapeHtml(suspect.author)}` : ""}`).join("; ");
    const blame = regression.suspects?.length === 1
      ? `Last green before ${suspects}`
      : (regression.suspects?.length ? `${regression.suspects.length} changes landed since it was green: ${suspects}` : "Nothing changed files since it was green");
    return `<div class="regression"><strong>${escapeHtml(regression.label)} regressed</strong><span>${blame}</span>${regression.fixAssignmentId ? `<small>A fix is queued.</small>` : ""}</div>`;
  }).join("");
}

function renderRoleOptions(select, catalogue, selected) {
  if (!select) return;
  const roles = catalogue?.roles?.length ? catalogue.roles : [{ name: "implementer" }];
  const keep = selected || select.value;
  select.innerHTML = roles.map((role) => {
    const marks = [role.plans ? "plans" : null, role.verifies ? "verifies" : null, role.writes ? "writes" : null].filter(Boolean);
    return `<option value="${escapeHtml(role.name)}" title="${escapeHtml(role.description || "")}">${escapeHtml(role.name)}${marks.length ? ` · ${marks.join(", ")}` : ""}</option>`;
  }).join("");
  if (keep && roles.some((role) => role.name === keep)) select.value = keep;
}
// A live "doing X" line for an agent: what it is working on right now, or how long it has waited.
function activityLine(agent) {
  if (agent.status === "busy" && agent.current_assignment_title) {
    const verb = ROLE_VERB[agent.current_assignment_role] || agent.current_assignment_role || "working on";
    const version = agent.current_task_version ? ` · v${agent.current_task_version}` : "";
    return `${verb}: ${agent.current_assignment_title}${version}`;
  }
  if (agent.status === "unresponsive") return `unresponsive · silent ${relativeTime(agent.last_seen)} (keeps its claim)`;
  if (agent.status === "waiting") return `waiting · ${relativeTime(agent.last_seen)}`;
  return relativeTime(agent.last_seen);
}



let state = null;
let selectedTaskId = new URLSearchParams(location.search).get("task");
let selectedProjectId = null;
let config = null;
let eventLookup = new Map();
let replyTo = null;
let refreshGeneration = 0;
let pendingAttachments = [];
let renderedTaskId = null;
let messageSending = false;
let pendingSends = [];
let pendingJumpEventId = null;
let searchGeneration = 0;
let focusedAssignmentId = null;
const ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DRAFT_LIMIT = 50_000;

function syncTaskUrl() {
  const url = new URL(location.href);
  if (selectedTaskId) url.searchParams.set("task", selectedTaskId);
  else url.searchParams.delete("task");
  history.replaceState({}, "", `${url.pathname}${url.search}`);
}

// On a loopback server the browser is handed a session cookie when it loads the page, so nothing
// here ever sees a 401. On a server bound to anything else there is no free cookie — the token has
// to be presented once, exchanged for a session, and the original request retried. Asking only when
// the server actually refuses keeps the local case exactly as friction-free as it was.
let authenticating = null;
async function api(url, options = {}, { retry = true } = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  if (response.status === 401 && retry) {
    const authenticated = await authenticate();
    if (authenticated) return api(url, options, { retry: false });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

async function authenticate() {
  // One prompt at a time, however many polls discover the 401 together.
  if (authenticating) return authenticating;
  authenticating = (async () => {
    const token = prompt("This DevTeam server requires its token.\n\nPaste the value of DEVTEAM_TOKEN (or a named token issued from the dashboard):");
    if (!token || !token.trim()) return false;
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token.trim() }),
    });
    return response.ok;
  })();
  try { return await authenticating; }
  finally { authenticating = null; }
}

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    return false; // Private browsing or a full storage quota must not break chat.
  }
}

const draftKey = (taskId) => `devteam:draft:${taskId}`;
const readKey = (taskId) => `devteam:last-read:${taskId}`;

function readDraft(taskId) {
  try { return JSON.parse(storageGet(draftKey(taskId)) || "null"); } catch { return null; }
}

function updateDraftStatus(message = "") {
  const status = $("#draft-status");
  if (status) status.textContent = message;
}

function saveMessageDraft(taskId = selectedTaskId) {
  if (!taskId) return;
  const form = $("#message-form");
  const message = form.elements.message.value.slice(0, DRAFT_LIMIT);
  const target = form.elements.target?.value || "all";
  if (!message) {
    storageSet(draftKey(taskId), null);
    updateDraftStatus("");
    return;
  }
  const saved = storageSet(draftKey(taskId), JSON.stringify({ message, target, savedAt: new Date().toISOString() }));
  updateDraftStatus(saved ? "Draft saved locally" : "Draft could not be saved locally");
}

function clearMessageDraft(taskId) {
  storageSet(draftKey(taskId), null);
  if (taskId === selectedTaskId) updateDraftStatus("");
}

function restoreMessageDraft(taskId) {
  const field = $("#message-form").elements.message;
  const draft = readDraft(taskId);
  field.value = draft?.message || "";
  resizeMessageField(field);
  updateDraftStatus(draft?.message ? "Draft restored" : "");
}

function lastReadEventId(taskId) {
  const value = Number(storageGet(readKey(taskId)));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function latestReadableEventId(task) {
  return Math.max(0, ...task.events.filter((event) => event.agent_id).map((event) => Number(event.id) || 0));
}

function markTimelineRead(task = state?.selectedTask) {
  if (!task) return;
  const latest = latestReadableEventId(task);
  if (latest) storageSet(readKey(task.id), String(latest));
  const button = $("#jump-latest");
  if (button) button.classList.add("hidden");
}

function toast(message) {
  const element = $("#toast"); element.textContent = message; element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 2300);
}

async function refresh() {
  const generation = ++refreshGeneration;
  const taskQuery = selectedTaskId
    ? `?taskId=${encodeURIComponent(selectedTaskId)}`
    : selectedProjectId ? "?taskId=" : "";
  const nextState = await api(`/api/state${taskQuery}`);
  if (generation !== refreshGeneration) return;
  state = nextState;
  if (state.selectedTask) {
    selectedTaskId = state.selectedTask.id;
    selectedProjectId = state.selectedTask.project_id;
  } else {
    selectedTaskId = null;
    if (!state.projects.some((project) => project.id === selectedProjectId)) selectedProjectId = state.projects[0]?.id || null;
  }
  syncTaskUrl();
  render();
}

function render() {
  const task = state.selectedTask;
  $("#project-list").innerHTML = state.projects.map((project) => `<div class="nav-row"><button class="project-item ${selectedProjectId === project.id ? "active" : ""}" data-project="${project.id}" title="Open ${escapeHtml(project.name)}"><span>${escapeHtml(project.name)}</span></button><span class="row-actions"><button class="row-edit" data-edit-project="${project.id}" title="Edit project name or folder" aria-label="Edit ${escapeHtml(project.name)}">✎</button><button class="row-delete" data-delete-project="${project.id}" title="Remove project from DevTeam" aria-label="Remove ${escapeHtml(project.name)} from DevTeam">×</button></span></div>`).join("") || `<p class="hint">No projects</p>`;
  const visibleTasks = selectedProjectId ? state.tasks.filter((item) => item.project_id === selectedProjectId) : state.tasks;
  $("#task-count").textContent = visibleTasks.length;
  $("#task-list").innerHTML = visibleTasks.map((item) => `<div class="nav-row"><button class="task-item ${task?.id === item.id ? "active" : ""}" data-task="${item.id}" title="Open task history"><span class="dot"></span><span>${escapeHtml(item.title)}<small>${escapeHtml(item.status)} · ${item.open_assignments} open</small></span></button><button class="row-delete" data-delete-task="${item.id}" title="Delete task history" aria-label="Delete task history for ${escapeHtml(item.title)}">×</button></div>`).join("") || `<p class="hint">No tasks yet</p>`;
  // What a collapsed section still shows. Kept in step with the lists so the sidebar never hides
  // which project and task you are looking at — that is the one thing it exists to tell you.
  const currentProject = state.projects.find((project) => project.id === selectedProjectId);
  $("#project-current").textContent = currentProject ? currentProject.name : "";
  $("#task-current").innerHTML = task
    ? `${escapeHtml(task.title)}<small>${escapeHtml(task.status)}</small>`
    : "";
  $("#project-select").innerHTML = state.projects.map((project) => `<option value="${project.id}" ${project.id === selectedProjectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("");

  $("#empty-state").classList.toggle("hidden", Boolean(task));
  $("#conversation").classList.toggle("hidden", !task);
  $("#work-board").classList.toggle("hidden", !task);
  $("#copy-task-invite").classList.toggle("hidden", !task);
  $("#edit-task").classList.toggle("hidden", !task || task.status === "cancelled");
  $("#block-task").classList.toggle("hidden", !task || ["accepted", "blocked", "cancelled"].includes(task.status));
  $("#unblock-task").classList.toggle("hidden", !task || task.status !== "blocked");
  renderBlockedBanner(task);
  if (task) renderTask(task);
  else document.title = "DevTeam — Local AI collaboration";
  renderAgents();
}

const KIND_LABELS = { "agent.question": "question", "agent.finding": "finding", "agent.decision": "decision", "agent.progress": "note" };

// Where a message stands for each agent it is meant for, by name: seen, delivered, waiting for the
// agent's next check, or waiting for it to rejoin. "Not delivered yet" alone never said whether that
// was a second's wait or a day's — and Codex, which connects one turn at a time, is usually offline.
function deliveryLine(event) {
  const target = event.metadata.targetLabel || "all agents";
  const receipts = event.receipts || [];
  const members = (state?.selectedTask?.members || []).filter((member) => member.role !== "observer");
  const wanted = String(event.metadata.target || "all").toLowerCase() === "all"
    ? [...new Set(members.map((member) => member.agent_name))]
    : [event.metadata.targetLabel || event.metadata.target];
  const byName = (name) => receipts.filter((receipt) => String(receipt.agent_name).toLowerCase() === String(name).toLowerCase());
  const connected = (name) => members.some((member) => member.agent_name.toLowerCase() === String(name).toLowerCase() && member.status !== "disconnected");
  const parts = wanted.filter(Boolean).map((name) => {
    const mine = byName(name);
    if (mine.some((receipt) => receipt.seen_at)) return { name, state: "seen", text: "seen" };
    if (mine.length) return { name, state: "delivered", text: "delivered" };
    if (connected(name)) return { name, state: "pending", text: "on its next check" };
    return { name, state: "offline", text: "offline — gets it when it rejoins" };
  });
  if (!parts.length) return `<div class="delivery"><span class="delivery-dot pending"></span>To ${escapeHtml(target)} · no agent has joined yet — it will be delivered when one does</div>`;
  const worst = ["offline", "pending", "delivered", "seen"].find((key) => parts.some((part) => part.state === key)) || "pending";
  return `<div class="delivery"><span class="delivery-dot ${worst === "offline" ? "pending" : worst}"></span><span class="delivery-text">To ${escapeHtml(target)} · ${parts.map((part) => `<span class="delivery-${part.state}">${escapeHtml(part.name)} ${escapeHtml(part.text)}</span>`).join(" · ")}</span></div>`;
}

const SYSTEM_EVENTS = ["task.created", "assignment.created", "task.accepted", "assignment.reassigned"];

// Authorship comes from the event's own recorded author, not from its nullable agent_id: purging an
// agent from the roster clears that foreign key, which used to reattribute every message it ever
// wrote to the human. Rows written before author_kind existed fall back to the old inference.
function eventIsHuman(event) {
  if (event.author_kind) return event.author_kind === "human";
  return !event.agent_id;
}

function eventAuthorName(event) {
  return event.agent_name || event.author_name || "Agent";
}

// Every check is the reporting agent's word — DevTeam runs nothing — so the label says what was
// reported rather than implying DevTeam confirmed it. Reports written before checks carried a status
// are plain strings, and read as the bare assertions they were.
function checkLabel(record) {
  if (record.status === "passed") return `check ✓ ${record.label} · reported passing`;
  if (record.status === "failed") return `check ✕ ${record.label} · reported failing`;
  return `check: ${record.label} · asserted`;
}

function checkChips(metadata) {
  const records = metadata.checkRecords;
  if (Array.isArray(records) && records.length) return records.map(checkLabel);
  return (metadata.checks || []).map((check) => `check: ${check} · asserted`);
}

function renderEvent(event) {
  if (SYSTEM_EVENTS.includes(event.type)) {
    const icon = "";
    return `<div id="event-${event.id}" class="system-event ${event.type.replace(".", "-")}">${icon}${escapeHtml(event.message)} <span class="provider">· ${time(event.created_at)}</span></div>`;
  }
  const human = eventIsHuman(event);
  const name = human ? "You" : eventAuthorName(event);
  const kind = KIND_LABELS[event.type];
  const meta = [
    ...(event.metadata.changedFiles || []).map((file) => `changed: ${file}`),
    ...checkChips(event.metadata),
    event.metadata.role ? `role: ${event.metadata.role}` : null,
  ].filter(Boolean);
  const badge = kind ? `<span class="kind-badge ${kind}">${escapeHtml(kind)}</span>` : "";
  const parent = event.metadata.replyTo ? eventLookup.get(event.metadata.replyTo) : null;
  const quote = parent
    ? `<div class="reply-quote">↳ ${escapeHtml(eventIsHuman(parent) ? "You" : eventAuthorName(parent))}: ${escapeHtml((parent.message || "").slice(0, 100))}</div>`
    : "";
  const parsed = parseAttachmentMarkers(event.message);
  const body = parsed.message ? `<div class="event-body markdown">${renderSafeMarkdown(parsed.message)}</div>` : "";
  const attachments = parsed.attachments.length ? `<div class="message-attachments">${parsed.attachments.map(renderMessageAttachment).join("")}</div>` : "";
  const agentColor = human ? "" : `agent-color-${agentColorIndex(name)}`;
  return `<article id="event-${event.id}" class="event ${human ? "from-human" : agentColor}"><div class="avatar ${human ? "human" : ""}">${initials(name)}</div><div class="event-main"><div class="event-top"><span class="event-name">${escapeHtml(name)}</span><span class="provider">${escapeHtml(human ? "you" : event.agent_provider || event.type)}</span>${badge}<span class="event-time">${time(event.created_at)}</span><button class="reply-btn" data-reply="${event.id}" title="Reply to this message" aria-label="Reply">↩</button></div>${quote}${body}${attachments}${meta.length ? `<div class="event-meta">${meta.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</div>` : ""}${human ? deliveryLine(event) : ""}</div></article>`;
}

function renderPendingSend(item) {
  const failed = item.status === "failed";
  const files = item.files.length ? `<div class="pending-file-names">${item.files.map((file) => escapeHtml(file.name)).join(" · ")}</div>` : "";
  const status = failed
    ? `<div class="delivery failed" role="status"><span class="delivery-dot failed"></span>Failed — ${escapeHtml(item.error || "message was not sent")}<button class="retry-send" type="button" data-retry-send="${item.id}">Retry</button></div>`
    : `<div class="delivery" role="status"><span class="delivery-dot pending"></span>Sending…</div>`;
  return `<article class="event from-human pending-send ${failed ? "failed" : ""}"><div class="avatar human">Y</div><div class="event-main"><div class="event-top"><span class="event-name">You</span><span class="provider">pending</span></div>${item.message ? `<div class="event-body markdown">${renderSafeMarkdown(item.message)}</div>` : ""}${files}${status}</div></article>`;
}

function renderTimeline(task, { taskChanged = false, wasNearBottom = false } = {}) {
  const eventList = $("#event-list");
  let marker = lastReadEventId(task.id);
  const latest = latestReadableEventId(task);
  if (marker === null && latest) {
    marker = latest;
    storageSet(readKey(task.id), String(latest));
  }
  const unread = unreadTimelineCount(task.events, marker);
  const parts = [];
  let separatorAdded = false;
  for (const event of task.events) {
    if (!separatorAdded && unread && event.agent_id && Number(event.id) > (marker || 0)) {
      parts.push(`<div id="unread-separator" class="unread-separator"><span>${unread} unread</span></div>`);
      separatorAdded = true;
    }
    const rendered = renderEvent(event);
    if (rendered) parts.push(rendered);
  }
  parts.push(...pendingSends.filter((item) => item.taskId === task.id).map(renderPendingSend));
  eventList.innerHTML = parts.join("") || `<p class="timeline-empty">No timeline items yet.</p>`;
  const jump = $("#jump-latest");
  jump.textContent = unread ? `↓ ${unread} new` : "↓";
  jump.classList.toggle("has-unread", Boolean(unread));
  jump.setAttribute("aria-label", unread ? `${unread} unread, jump to latest` : "Jump to latest");
  jump.classList.toggle("hidden", !unread && (taskChanged || wasNearBottom));
  requestAnimationFrame(() => {
    if (pendingJumpEventId) {
      const target = $(`#event-${pendingJumpEventId}`);
      if (target) target.scrollIntoView({ block: "center" });
      pendingJumpEventId = null;
    } else if (taskChanged && unread) {
      $("#unread-separator")?.scrollIntoView({ block: "start" });
    } else if (taskChanged || wasNearBottom) {
      eventList.scrollTo({ top: eventList.scrollHeight, behavior: taskChanged ? "auto" : "smooth" });
      markTimelineRead(task);
    }
  });
}

function parseAttachmentMarkers(message) {
  const attachments = [];
  const visible = String(message || "").replace(/^\[\[devteam-attachment (.+)\]\]\s*$/gm, (line, payload) => {
    try {
      const attachment = JSON.parse(payload);
      if (attachment && typeof attachment.path === "string" && typeof attachment.name === "string") attachments.push(attachment);
    } catch { return line; }
    return "";
  }).trim();
  return { message: visible, attachments };
}

function renderMessageAttachment(attachment) {
  const previewUrl = String(attachment.previewUrl || "");
  const localPreview = /^\/api\/tasks\/[0-9a-f-]+\/attachments\/[0-9a-f-]+\.(?:png|jpg|gif|webp|pdf)$/.test(previewUrl);
  const image = String(attachment.mime || "").startsWith("image/") && localPreview
    ? `<img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(attachment.name)}" loading="lazy">`
    : `<span class="attachment-type">PDF</span>`;
  const open = localPreview ? `<a href="${escapeHtml(previewUrl)}" target="_blank" rel="noopener">Open</a>` : "";
  return `<div class="message-attachment">${image}<div><strong>${escapeHtml(attachment.name)}</strong><code title="${escapeHtml(attachment.path)}">${escapeHtml(attachment.path)}</code>${open}</div></div>`;
}

// The Resume control used to live only at the foot of the team panel, below the roster, the whole
// work queue, the knowledge vault and consensus — on a busy task roughly 4,800px down a scrolling
// panel. A human looking for it found more assignment cards and concluded DevTeam could not reopen
// the task at all. The banner puts the same action where the eye already is.
function renderBlockedBanner(task) {
  const banner = $("#blocked-banner");
  const copy = task ? blockedBannerCopy(task.blockedRecovery) : null;
  banner.classList.toggle("hidden", !copy);
  if (!copy) return;
  $("#blocked-reason").textContent = copy.reason;
  $("#blocked-meta").textContent = copy.meta;
}

function assignmentDetailMarkup(item) {
  const description = item.description ? `<p class="assignment-description">${escapeHtml(item.description)}</p>` : "";
  const checklist = item.checklist?.length
    ? `<details class="checklist"><summary>${item.checklist.length}-point checklist</summary><ul>${item.checklist.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul></details>`
    : "";
  const leaseIsLive = item.status === "queued" || item.status === "claimed";
  const scope = item.requires_write && leaseIsLive
    ? `<span class="scope" title="Write lease scope">${(item.writeScope?.length ? item.writeScope : [""]).map((path) => escapeHtml(path || "whole project")).join(", ")}</span>`
    : "";
  const release = item.status === "claimed" && item.requires_write
    ? `<button class="mini release" data-release="${escapeHtml(item.id)}" data-release-title="${escapeHtml(item.title)}" title="Force-release this stuck write lease (asks you to confirm the title)">Release lease</button>`
    : "";
  const sendBack = item.status === "done"
    ? `<button class="mini send-back" data-send-back="${escapeHtml(item.id)}" data-send-back-title="${escapeHtml(item.title)}" title="Send this work back to its author for changes, with your reasons attached">Request changes</button>`
    : "";
  const blockedBy = item.blockedBy?.length
    ? `<div class="dependency-wait"><strong>Waiting for</strong>${item.blockedBy.map((dependency) => `<span>${escapeHtml(dependency.title)} · ${escapeHtml(dependency.status)}</span>`).join("")}</div>`
    : "";
  const checks = item.checks?.length
    ? `<div class="reported-checks">${item.checks.map((record) => `<span class="check-chip ${escapeHtml(record.status)}" title="${escapeHtml(record.output || "")}">${escapeHtml(checkLabel(record))}</span>`).join("")}</div>`
    : "";
  const hold = item.schedulingHold
    ? `<div class="scheduling-hold"><strong>Held back</strong><span>${escapeHtml(item.schedulingHold.detail)}</span></div>`
    : "";
  const findings = item.findings?.length
    ? `<ul class="finding-list">${item.findings.map((finding) => `<li>${finding.path ? `<code>${escapeHtml(finding.path)}</code> ` : ""}${escapeHtml(finding.detail)}<small>${escapeHtml(finding.requested_by_name)}</small></li>`).join("")}</ul>`
    : "";
  const rework = item.rework_requested_at
    ? `<div class="rework"><strong>Changes requested${Number(item.rework_count) > 1 ? ` · ${Number(item.rework_count)} times` : ""}</strong><span>${escapeHtml(item.rework_summary || "Sent back to its author.")}</span>${findings}</div>`
    : (item.findings?.length ? `<div class="rework"><strong>Open findings</strong>${findings}</div>` : "");
  const holder = item.agent_name ? `${item.agent_name} · ` : "";
  const round = Number(item.review_round) > 1 ? ` · round ${Number(item.review_round)}` : "";
  const closed = item.status === "closed"
    ? `<div class="scheduling-hold"><strong>Set aside</strong><span>${escapeHtml(item.closed_reason || "Closed.")}</span></div>`
    : "";
  const addressed = item.target_agent_name && ["queued", "blocked"].includes(item.status)
    ? `<p class="assignment-addressed">For ${escapeHtml(item.target_agent_name)}</p>`
    : "";
  // Fixing a card instead of copying it: reopen or close a blocked one, edit or close a waiting one.
  // A finished task is a record, and a stopped one is restarted as a whole, so neither offers them.
  const taskStatus = state?.selectedTask?.status;
  const taskOpen = !["accepted", "cancelled", "blocked"].includes(taskStatus);
  const cardActions = !taskOpen ? "" : [
    ["blocked", "closed"].includes(item.status) ? `<button class="mini" type="button" data-card-action="reopen" data-card-id="${escapeHtml(item.id)}">Reopen</button>` : "",
    ["queued", "blocked"].includes(item.status) ? `<button class="mini" type="button" data-card-action="edit" data-card-id="${escapeHtml(item.id)}">Edit</button>` : "",
    ["queued", "blocked"].includes(item.status) ? `<button class="mini danger" type="button" data-card-action="close" data-card-id="${escapeHtml(item.id)}">Close</button>` : "",
  ].join("");
  return `<div class="assignment"><div class="assignment-top"><strong>${escapeHtml(item.title)}</strong><button class="assignment-detail-close" type="button" data-assignment-close aria-label="Close assignment details">×</button></div><span class="role">${escapeHtml(roleWord(item.role))}${escapeHtml(round)}</span><p>${escapeHtml(`${holder}${statusWord(item.status)}`)}${item.requires_write && leaseIsLive ? " · write lease" : ""}</p>${addressed}${closed}${description}${rework}${hold}${blockedBy}${checks}${scope}${checklist}<div class="assignment-actions">${cardActions}${sendBack}${release}</div></div>`;
}

// The three roles in the words the board uses: a plan, a build, a review.
const roleWord = (role) => ({ planner: "Plan", implementer: "Build", reviewer: "Review" }[role] || role || "Work");
const statusWord = (status) => ({ queued: "waiting", claimed: "working", done: "done", blocked: "needs a decision", closed: "set aside" }[status] || status);

// The closed strip. Every chip opens the board on that note, so the one-line answer to "what is
// happening" and the whole graph are one click apart in either direction.
function renderCurrentWork(task) {
  const strip = $("#board-now");
  const { items, more } = currentWork(task.assignments || [], 3, task.status);
  const chips = items.map((item) => {
    const colorClass = item.agent_name ? `agent-color-${agentColorIndex(item.agent_name)}` : "is-unclaimed";
    // Only a holder earns space here. "Unclaimed" on three chips in a row is three copies of what
    // the pale border already says, and it is the half of the chip that truncates the title.
    const holder = item.agent_name
      ? `<span class="board-chip-meta"><span class="agent-swatch"></span>${escapeHtml(item.agent_name)}</span>`
      : "";
    return `<button class="board-chip status-${escapeHtml(item.status)} ${colorClass}" type="button" data-board-chip="${escapeHtml(item.id)}" title="${escapeHtml(item.title)} · ${escapeHtml(item.role)} · ${escapeHtml(item.status)}${item.agent_name ? ` · ${escapeHtml(item.agent_name)}` : ""}"><span class="board-chip-title">${escapeHtml(item.title)}</span>${holder}</button>`;
  });
  if (more) chips.push(`<span class="board-more">+${more}</span>`);
  strip.innerHTML = chips.join("");
}

// What an unclaimed, ready note is waiting for, in the few words a card has room for. Only for work
// whose own dependencies are done: a note still waiting on earlier work already says so by its place
// on the board, and naming a teammate there would point at the wrong holdup.
function waitingLabel(item) {
  const hold = item.schedulingHold;
  if (item.status !== "queued" || !hold || item.blockedBy?.length) return null;
  if (hold.reason === "waiting_for_team") return `Waiting for ${(hold.waitingFor || []).join(" or ")}`;
  if (hold.reason === "verifier_is_author") return "Needs a reviewer who didn't write it";
  if (hold.reason === "awaiting_writer") return "Waiting for the build";
  if (hold.reason === "write_lease_conflict") return "Waiting for a file lock";
  return null;
}

// The work board: a flowchart of how the work went (layoutFlowBoard in ui-utils.js). Each step is a
// piece of work with its review directly beneath it; send-backs are a loop on the step, not more cards;
// and whatever left the flow — closed, replaced, decided, or left blocked on a finished task — waits in
// "set aside" below, one click from its details.
let setAsideOpen = false;

function flowCardMarkup(node, step) {
  const item = node.card;
  const waiting = item.agent_name ? null : waitingLabel(item);
  const decision = step?.decision && node.kind === "main" && item.status === "blocked"
    ? (step.decision.agent_name ? `${step.decision.agent_name} is deciding` : "Waiting for the planner")
    : null;
  const holder = item.agent_name
    ? `<span class="flow-holder"><span class="agent-swatch"></span>${escapeHtml(item.agent_name)}</span>`
    : waiting
      ? `<span class="flow-holder waiting" title="${escapeHtml(item.schedulingHold.detail)}">${escapeHtml(waiting)}</span>`
      : `<span class="flow-holder unclaimed">${item.target_agent_name ? `For ${escapeHtml(item.target_agent_name)}` : "Unclaimed"}</span>`;
  const icon = { queued: "○", claimed: "●", done: "✓", blocked: "!" }[item.status] || "•";
  const round = node.kind === "review" && node.rounds > 1 ? `<span class="flow-badge">Round ${node.rounds}</span>` : "";
  const status = item.status === "blocked" ? "Needs a decision" : statusWord(item.status);
  return `<span class="flow-card-top"><span class="flow-role">${escapeHtml(roleWord(item.role))}</span>${round}<span class="flow-status">${icon} ${escapeHtml(status)}</span></span><span class="flow-title">${escapeHtml(item.title)}</span><span class="flow-foot">${holder}${decision ? `<span class="flow-decision">${escapeHtml(decision)}</span>` : ""}</span>`;
}

function renderAssignmentBoard(task) {
  const board = $("#assignment-board");
  const empty = board.querySelector(".assignment-board-empty");
  const canvas = board.querySelector(".assignment-board-canvas");
  const nodesContainer = board.querySelector(".assignment-nodes");
  const setAside = board.querySelector(".flow-set-aside");
  const detail = $("#assignment-detail");
  const assignments = task.assignments || [];
  const model = buildFlowModel(assignments, { taskStatus: task.status });
  empty.classList.toggle("hidden", model.steps.length > 0);
  canvas.classList.toggle("hidden", model.steps.length === 0);
  if (!assignments.length) {
    nodesContainer.replaceChildren();
    setAside.replaceChildren();
    detail.classList.add("hidden");
    focusedAssignmentId = null;
    return;
  }

  // Zoom widens the gaps, never the cards: the same steps in the same order, further apart, so the
  // arrows between them get room to be read. The layout is plain arithmetic, so re-running it for a
  // zoom step costs nothing and cannot reorder anything.
  const layout = layoutFlowBoard(model, {
    columnGap: BOARD_SIBLING_GAP * boardZoom,
    rowGap: BOARD_LAYER_GAP * boardZoom,
  });
  canvas.style.width = `${layout.width}px`;
  canvas.style.height = `${layout.height}px`;
  const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
  board.querySelector(".assignment-lanes").innerHTML = layout.rows.map((row) =>
    `<div class="assignment-lane" style="top:${row.y}px;height:${row.height}px"><span>${escapeHtml(row.label)}</span>${row.startedAt ? `<small>${escapeHtml(clock(row.startedAt))}</small>` : ""}</div>`).join("");
  const svg = board.querySelector(".assignment-edges");
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  const marker = (id, cls) => `<marker id="${id}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path class="${cls}" d="M0,0 L8,4 L0,8 Z"></path></marker>`;
  svg.innerHTML = `<defs>${marker("flow-arrow", "flow-arrow-head")}${marker("flow-arrow-quiet", "flow-arrow-head quiet")}${marker("flow-arrow-rework", "flow-arrow-head rework")}</defs>${layout.edges.map((edge) => {
    const head = edge.type === "rework" ? "flow-arrow-rework" : edge.type === "sequence" ? "flow-arrow-quiet" : "flow-arrow";
    const label = edge.label ? `<text class="flow-edge-label" x="${edge.labelX}" y="${edge.labelY}">${escapeHtml(edge.label)}</text>` : "";
    return `<path class="assignment-edge ${edge.type}" d="${edge.path}" marker-end="url(#${head})"></path>${label}`;
  }).join("")}`;

  const stepById = new Map(model.steps.map((step) => [step.id, step]));
  const existing = new Map([...nodesContainer.querySelectorAll("[data-assignment-focus]")].map((node) => [node.dataset.assignmentFocus, node]));
  const liveIds = new Set();
  for (const node of layout.nodes) {
    const item = node.card;
    liveIds.add(node.id);
    let button = existing.get(node.id);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.dataset.assignmentFocus = node.id;
      nodesContainer.append(button);
    }
    const colorClass = item.agent_name ? `agent-color-${agentColorIndex(item.agent_name)}` : "is-unclaimed";
    const waiting = !item.agent_name && waitingLabel(item) ? " is-waiting" : "";
    button.className = `assignment-node flow-card kind-${node.kind} role-${escapeHtml(item.role)} status-${item.status} ${colorClass}${waiting}${focusedAssignmentId === node.id ? " selected" : ""}`;
    button.style.width = `${node.width}px`;
    button.style.height = `${node.height}px`;
    button.style.transform = `translate(${node.x}px, ${node.y}px)`;
    button.title = item.title;
    button.setAttribute("aria-expanded", String(focusedAssignmentId === node.id));
    button.setAttribute("aria-label", `${roleWord(item.role)}: ${item.title}, ${item.agent_name ? `held by ${item.agent_name}, ` : ""}${statusWord(item.status)}${node.rounds > 1 ? `, round ${node.rounds}` : ""}`);
    button.innerHTML = flowCardMarkup(node, stepById.get(node.stepId));
  }
  for (const [id, node] of existing) if (!liveIds.has(id)) node.remove();

  // Set aside: never deleted, just out of the flow. The open/closed state survives re-renders.
  if (model.setAside.length) {
    setAside.innerHTML = `<details ${setAsideOpen ? "open" : ""}><summary>${model.setAside.length} set aside <span>closed, replaced or decided cards — kept for the record</span></summary><div class="flow-set-aside-list">${model.setAside.map(({ card, reason }) =>
      `<button type="button" class="flow-set-aside-item${focusedAssignmentId === String(card.id) ? " selected" : ""}" data-assignment-focus="${escapeHtml(card.id)}"><span class="flow-role">${escapeHtml(roleWord(card.role))}</span><strong>${escapeHtml(card.title)}</strong><small>${escapeHtml(reason)}</small></button>`).join("")}</div></details>`;
    setAside.querySelector("details").addEventListener("toggle", (event) => { setAsideOpen = event.target.open; });
  } else {
    setAside.replaceChildren();
  }

  const assignmentById = new Map(assignments.map((item) => [String(item.id), item]));
  const focused = focusedAssignmentId ? assignmentById.get(String(focusedAssignmentId)) : null;
  if (!focused && focusedAssignmentId) focusedAssignmentId = null;
  detail.classList.toggle("hidden", !focused);
  detail.innerHTML = focused ? assignmentDetailMarkup(focused) : "";
}

// The map: the same board, showing the code instead of the plan.
//
// The work board answers "what is the team doing"; the map answers "where in the project is it
// happening". Both are drawn from what was already recorded — the code graph indexes the files,
// notes name the files they are about, and completed assignments report the files they changed —
// so nothing here asks an agent to do anything new.
//
// The data is fetched once per task rather than ridden along with the dashboard snapshot: 310
// modules is ~78 KB, it changes only when the code does, and most of the time nobody is looking.
const MAP_STALE_MS = 60_000;
let mapState = { taskId: null, data: null, layout: null, size: "", loading: false, error: null, fetchedAt: 0 };
let mapSelected = null;
// Test files double a project's file count and sit on top of the code they test, so the map starts
// with them set aside; one chip brings them back. Remembered per browser.
let mapShowTests = false;
try { mapShowTests = localStorage.getItem("devteam.mapTests") === "show"; } catch { /* private window */ }

// What the map draws: the data, less the test files when they are set aside.
function visibleMapData(data) {
  if (mapShowTests) return data;
  const keep = new Set(data.modules.filter((module) => !isTestPath(module.path)).map((module) => module.path));
  return {
    ...data,
    modules: data.modules.filter((module) => keep.has(module.path)),
    edges: data.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to)),
    notes: (data.notes || []).map((note) => ({ ...note, files: note.files.filter((file) => keep.has(file)) })).filter((note) => note.files.length),
    touched: (data.touched || []).filter((entry) => keep.has(entry.file)),
  };
}
// The file under the pointer. Kept across repaints, because zooming redraws every node.
let mapHovered = null;
let mapGroupFilter = null;

// Zoom, for both views. It spreads positions and leaves sizes alone (see paintCodeMap and
// renderAssignmentBoard), and it is purely a view: nothing here re-runs the map's simulation.
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;
const MAP_LABEL_ALL_ZOOM = 2.5;
const BOARD_SIBLING_GAP = 26;
const BOARD_LAYER_GAP = 46;
const MAP_VIEW_HOME = Object.freeze({ k: 1, tx: 0, ty: 0 });
let boardZoom = 1;
// Screen = layout × k + t. At k = 1 the map fills its box exactly, so the pan is clamped to keep the
// zoomed picture covering the box rather than sliding off into empty space.
let mapView = { ...MAP_VIEW_HOME };
const clampZoom = (k) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(k) || ZOOM_MIN));
function clampMapView(view, width, height) {
  const k = clampZoom(view.k);
  return {
    k,
    tx: Math.min(0, Math.max(width - width * k, view.tx)),
    ty: Math.min(0, Math.max(height - height * k, view.ty)),
  };
}

async function loadCodeMap(taskId, { force = false } = {}) {
  if (!taskId) return;
  const fresh = mapState.taskId === taskId && mapState.data && Date.now() - mapState.fetchedAt < MAP_STALE_MS;
  if (!force && (fresh || mapState.loading)) return;
  if (mapState.taskId !== taskId) {
    mapState = { taskId, data: null, layout: null, size: "", loading: true, error: null, fetchedAt: 0 };
    mapSelected = null;
    mapGroupFilter = null;
    mapView = { ...MAP_VIEW_HOME };
  } else {
    mapState.loading = true;
  }
  renderCodeMap();
  try {
    const data = await api(`/api/tasks/${taskId}/map`);
    // The task can change while the request is in flight; a late answer must not overwrite the
    // map of whatever the person is looking at now.
    if (mapState.taskId !== taskId) return;
    mapState = { ...mapState, data, layout: null, size: "", loading: false, error: null, fetchedAt: Date.now() };
  } catch (error) {
    if (mapState.taskId !== taskId) return;
    mapState = { ...mapState, loading: false, error: error.message || "The map could not be read." };
  }
  renderCodeMap();
}

function mapSummaryLine(data, layout) {
  const tests = mapShowTests ? 0 : data.modules.filter((module) => isTestPath(module.path)).length;
  const files = data.modules.length - tests;
  const noted = new Set((data.notes || []).flatMap((note) => note.files || [])).size;
  const imports = layout ? layout.edges.length : data.edges.length;
  const parts = [`${files} file${files === 1 ? "" : "s"}`, `${imports} import${imports === 1 ? "" : "s"}`];
  if (data.touched.length) parts.push(`${data.touched.length} touched by this task`);
  if (noted) parts.push(`${noted} with notes`);
  if (layout?.dropped) parts.push(`${layout.dropped} leaf files hidden`);
  if (tests) parts.push(`${tests} test files set aside`);
  if (data.truncated) parts.push("index truncated");
  if (data.indexedAt) parts.push(`indexed ${relativeTime(data.indexedAt)}`);
  return parts.join(" · ");
}

// Markup only — the layout is cached, so selecting a file or a folder repaints without running
// the simulation again.
function paintCodeMap() {
  const svg = $("#code-map-svg");
  const layout = mapState.layout;
  if (!svg || !layout) return;
  const groupColour = new Map(layout.groups.map((group) => [group.name, group.index % 8]));
  const neighbours = new Set();
  if (mapSelected) {
    neighbours.add(mapSelected);
    for (const edge of layout.edges) {
      if (edge.from === mapSelected) neighbours.add(edge.to);
      if (edge.to === mapSelected) neighbours.add(edge.from);
    }
  }
  const dimmed = (node) => {
    if (mapSelected) return !neighbours.has(node.path);
    if (mapGroupFilter) return node.group !== mapGroupFilter;
    return false;
  };
  // Two different emphases, and they must not be confused: `lit` is the file you are reading and
  // what it connects to, `live` is where this task has been working. Selection wins, because while
  // one file is selected that is the only question being asked.
  // Zoom moves positions and nothing else. Radii, strokes and labels are drawn at their own size, so
  // zooming in pulls a cluster apart instead of magnifying it into one bigger blob.
  const { k, tx, ty } = mapView;
  const sx = (x) => (x * k + tx).toFixed(1);
  const sy = (y) => (y * k + ty).toFixed(1);
  const edgeMarkup = layout.edges.map((edge) => {
    const lit = mapSelected && (edge.from === mapSelected || edge.to === mapSelected);
    const live = !mapSelected && edge.live;
    const faded = mapSelected ? !lit : Boolean(mapGroupFilter);
    return `<line class="map-edge${lit ? " lit" : ""}${live ? " live" : ""}${faded ? " dim" : ""}" x1="${sx(edge.x1)}" y1="${sy(edge.y1)}" x2="${sx(edge.x2)}" y2="${sy(edge.y2)}"></line>`;
  }).join("");
  const nodeMarkup = layout.nodes.map((node) => {
    const classes = [`map-node`, `map-group-${groupColour.get(node.group) ?? 0}`];
    if (node.touched) classes.push("touched");
    if (node.notes.length) classes.push("noted");
    if (mapSelected === node.path) classes.push("selected");
    if (mapHovered === node.path) classes.push("hovered");
    if (dimmed(node)) classes.push("dim");
    // The hover card (showMapHover) labels the files too small to carry a name; aria-label is for keyboards.
    const tip = `${node.path}${node.degree ? ` — ${node.degree} link${node.degree === 1 ? "" : "s"}` : ""}${node.touched ? ` — changed ${node.touched}× by this task` : ""}${node.notes.length ? ` — ${node.notes.length} note${node.notes.length === 1 ? "" : "s"}` : ""}`;
    return `<g class="${classes.join(" ")}" data-map-node="${escapeHtml(node.path)}" tabindex="0" role="button" aria-label="${escapeHtml(tip)}"><circle cx="${sx(node.x)}" cy="${sy(node.y)}" r="${node.r.toFixed(1)}"></circle>${node.notes.length ? `<circle class="map-note-ring" cx="${sx(node.x)}" cy="${sy(node.y)}" r="${(node.r + 3.2).toFixed(1)}"></circle>` : ""}</g>`;
  }).join("");
  // Spread far enough apart, every file has room for its name, not just the ones the layout picked.
  const labelAll = k >= MAP_LABEL_ALL_ZOOM;
  const areaMarkup = layout.groups.length > 1 ? layout.groups.map((group) =>
    `<text class="map-area-label map-group-${group.index % 8}${mapGroupFilter && mapGroupFilter !== group.name ? " dim" : ""}" x="${sx(group.labelX)}" y="${sy(group.labelY)}">${escapeHtml(group.label)}</text>`).join("") : "";
  const labelMarkup = layout.nodes.filter((node) => (node.labelled || labelAll) && !dimmed(node)).map((node) =>
    `<text class="map-label${node.touched ? " touched" : ""}" x="${sx(node.x)}" y="${(node.y * k + ty - node.r - 5).toFixed(1)}">${escapeHtml(node.name)}</text>`).join("");
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  svg.innerHTML = `<g class="map-edges">${edgeMarkup}</g><g class="map-areas" aria-hidden="true">${areaMarkup}</g><g class="map-nodes">${nodeMarkup}</g><g class="map-labels" aria-hidden="true">${labelMarkup}</g>`;

  const legend = $("#code-map-legend");
  const testCount = (mapState.data?.modules || []).filter((module) => isTestPath(module.path)).length;
  const testsChip = testCount
    ? `<button class="map-legend-chip map-tests-toggle${mapShowTests ? " active" : ""}" type="button" data-map-tests aria-pressed="${mapShowTests}" title="${mapShowTests ? "Set the test files aside" : "Show the test files beside the code they test"}">${mapShowTests ? "Hide" : "Show"} tests<span class="map-legend-count">${testCount}</span></button>`
    : "";
  legend.innerHTML = layout.groups.map((group) =>
    `<button class="map-legend-chip map-group-${group.index % 8}${mapGroupFilter === group.name ? " active" : ""}" type="button" data-map-group="${escapeHtml(group.name)}" title="${escapeHtml(group.name)} — ${group.count} file${group.count === 1 ? "" : "s"}${group.touched ? `, ${group.touched} touched by this task` : ""}"><span class="map-legend-dot"></span>${escapeHtml(group.label)}<span class="map-legend-count">${group.count}</span></button>`).join("") + testsChip;

  const detail = $("#code-map-detail");
  const node = mapSelected ? layout.nodes.find((candidate) => candidate.path === mapSelected) : null;
  detail.classList.toggle("hidden", !node);
  if (!node) { detail.innerHTML = ""; return; }
  const importList = layout.edges.filter((edge) => edge.from === node.path).map((edge) => edge.to);
  const importerList = layout.edges.filter((edge) => edge.to === node.path).map((edge) => edge.from);
  const imports = importList.length;
  const importedBy = importerList.length;
  const fileList = (label, files) => (files.length
    ? `<div class="map-detail-links"><span class="section-label">${label}</span>${files.slice(0, 14).map((file) =>
      `<button type="button" class="map-detail-link" data-map-jump="${escapeHtml(file)}">${escapeHtml(file.slice(file.lastIndexOf("/") + 1))}<small>${escapeHtml(file.slice(0, file.lastIndexOf("/") + 1))}</small></button>`).join("")}${files.length > 14 ? `<small class="map-detail-more">and ${files.length - 14} more</small>` : ""}</div>`
    : "");
  const facts = [
    node.language || "file",
    node.loc ? `${node.loc} lines` : null,
    `imports ${imports}`,
    `imported by ${importedBy}`,
  ].filter(Boolean).join(" · ");
  const touched = node.touched
    ? `<p class="map-detail-touched">Changed ${node.touched}× while this task ran.</p>`
    : "";
  // Notes come last and fold after three: a note is pinned to every file its report changed, so a
  // busy file collects notes that are about its neighbours as much as about it.
  const noteRow = (note) => `<div class="map-detail-note"><span class="role">${escapeHtml(note.category)}</span><span>${escapeHtml(note.title)}</span></div>`;
  const notes = node.notes.length
    ? `<div class="map-detail-notes"><span class="section-label">What the team knows</span>${node.notes.slice(0, 3).map(noteRow).join("")}${node.notes.length > 3
      ? `<details class="map-detail-more-notes"><summary>${node.notes.length - 3} more</summary>${node.notes.slice(3).map(noteRow).join("")}</details>`
      : ""}</div>`
    : "";
  const purpose = node.summary ? `<p class="map-detail-purpose">${escapeHtml(node.summary)}</p>` : "";
  detail.innerHTML = `<div class="map-detail-top"><strong>${escapeHtml(node.name)}</strong><button class="assignment-detail-close" type="button" data-map-close aria-label="Close file details">×</button></div><code class="map-detail-path">${escapeHtml(node.path)}</code>${purpose}<p class="map-detail-facts">${escapeHtml(facts)}</p>${touched}${fileList("Uses", importList)}${fileList("Used by", importerList)}${notes}`;
}

function renderCodeMap({ relayout = false } = {}) {
  const panel = $("#code-map");
  if (!panel || panel.classList.contains("hidden")) return;
  const summary = $("#code-map-summary");
  const canvas = $("#code-map-canvas");
  const svg = $("#code-map-svg");
  if (mapState.error) {
    summary.textContent = mapState.error;
    svg.innerHTML = "";
    return;
  }
  if (!mapState.data) {
    summary.textContent = mapState.loading ? "Reading the project…" : "No map yet.";
    svg.innerHTML = "";
    return;
  }
  if (!mapState.data.modules.length) {
    summary.textContent = mapState.data.automated
      ? "Nothing indexed yet — the map fills in once the code graph has read this project."
      : "The code graph is switched off, so there is nothing to map.";
    svg.innerHTML = "";
    $("#code-map-legend").innerHTML = "";
    return;
  }
  // The simulation costs ~130ms on a 310-file project, so it runs when the data or the box
  // actually changes and never on a repaint.
  const width = Math.max(320, Math.round(canvas.clientWidth) || 900);
  const height = Math.max(260, Math.round(canvas.clientHeight) || 620);
  const size = `${width}x${height}`;
  if (relayout || !mapState.layout || mapState.size !== size) {
    mapState.layout = layoutCodeMap(visibleMapData(mapState.data), { width, height });
    mapState.size = size;
    // A resize keeps the zoom the person chose; only the pan is pulled back inside the new box.
    mapView = clampMapView(mapView, width, height);
  }
  summary.textContent = mapSummaryLine(mapState.data, mapState.layout);
  paintCodeMap();
}

// Most files are drawn as 6px dots, and zoom spreads them apart without growing them, so hitting
// the circle itself is a game of precision. The pointer instead picks the file whose edge is
// nearest, within a finger-sized reach on screen. Inside a circle the distance is negative, so a
// hub still wins over a small file drawn just beside it.
const MAP_REACH_PX = 14;
function mapNodeAt(clientX, clientY) {
  const svg = $("#code-map-svg");
  const layout = mapState.layout;
  const matrix = svg?.getScreenCTM();
  if (!layout || !matrix) return null;
  const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
  const scale = Math.hypot(matrix.a, matrix.b) || 1;
  const { k, tx, ty } = mapView;
  let best = null;
  let bestGap = MAP_REACH_PX / scale;
  for (const node of layout.nodes) {
    const gap = Math.hypot(node.x * k + tx - point.x, node.y * k + ty - point.y) - node.r;
    if (gap < bestGap) { best = node; bestGap = gap; }
  }
  return best;
}

function showMapHover(node, event) {
  const card = $("#code-map-hover");
  const canvas = $("#code-map-canvas");
  const svg = $("#code-map-svg");
  const previous = mapHovered && svg.querySelector(`[data-map-node="${CSS.escape(mapHovered)}"]`);
  if (previous) previous.classList.remove("hovered");
  mapHovered = node?.path || null;
  canvas.classList.toggle("over-node", Boolean(node));
  if (!node) { card.classList.add("hidden"); return; }
  svg.querySelector(`[data-map-node="${CSS.escape(node.path)}"]`)?.classList.add("hovered");
  const links = node.degree ? `${node.degree} link${node.degree === 1 ? "" : "s"}` : "no imports";
  const extra = [links, node.touched ? `changed ${node.touched}× by this task` : null, node.notes.length ? `${node.notes.length} note${node.notes.length === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ");
  card.innerHTML = `<strong>${escapeHtml(node.name)}</strong><code>${escapeHtml(node.path)}</code>${node.summary ? `<em>${escapeHtml(node.summary)}</em>` : ""}<span>${escapeHtml(extra)}</span>`;
  card.classList.remove("hidden");
  // Beside the pointer, flipped to the other side near the right or bottom edge.
  const box = canvas.getBoundingClientRect();
  const x = event.clientX - box.left;
  const y = event.clientY - box.top;
  const flipX = x + 16 + card.offsetWidth > box.width;
  const flipY = y + 16 + card.offsetHeight > box.height;
  card.style.left = `${Math.max(4, flipX ? x - 16 - card.offsetWidth : x + 16)}px`;
  card.style.top = `${Math.max(4, flipY ? y - 16 - card.offsetHeight : y + 16)}px`;
}

$("#code-map-svg").addEventListener("click", (event) => {
  const path = mapNodeAt(event.clientX, event.clientY)?.path || null;
  mapSelected = mapSelected === path ? null : path;
  if (mapSelected) mapGroupFilter = null;
  paintCodeMap();
  if (mapHovered) showMapHover(mapState.layout?.nodes.find((node) => node.path === mapHovered), event);
});
$("#code-map-svg").addEventListener("pointermove", (event) => {
  if ($("#code-map-canvas").classList.contains("is-panning")) return showMapHover(null);
  showMapHover(mapNodeAt(event.clientX, event.clientY), event);
});
$("#code-map-svg").addEventListener("pointerleave", () => showMapHover(null));
$("#code-map-svg").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const node = event.target.closest("[data-map-node]");
  if (!node) return;
  event.preventDefault();
  mapSelected = mapSelected === node.dataset.mapNode ? null : node.dataset.mapNode;
  paintCodeMap();
});
$("#code-map-legend").addEventListener("click", (event) => {
  if (event.target.closest("[data-map-tests]")) {
    mapShowTests = !mapShowTests;
    try { localStorage.setItem("devteam.mapTests", mapShowTests ? "show" : "hide"); } catch { /* private window */ }
    mapSelected = null;
    mapGroupFilter = null;
    renderCodeMap({ relayout: true });
    return;
  }
  const chip = event.target.closest("[data-map-group]");
  if (!chip) return;
  mapGroupFilter = mapGroupFilter === chip.dataset.mapGroup ? null : chip.dataset.mapGroup;
  mapSelected = null;
  paintCodeMap();
});
$("#code-map-detail").addEventListener("click", (event) => {
  const jump = event.target.closest("[data-map-jump]");
  if (jump) {
    mapSelected = jump.dataset.mapJump;
    paintCodeMap();
    return;
  }
  if (!event.target.closest("[data-map-close]")) return;
  mapSelected = null;
  paintCodeMap();
});

// The map is laid out to the box it is drawn in, so the box changing is the one thing that has to
// re-run the simulation. Debounced, and only when the size really moved.
let mapResizeTimer = null;
if (typeof ResizeObserver === "function") {
  new ResizeObserver(() => {
    clearTimeout(mapResizeTimer);
    mapResizeTimer = setTimeout(() => renderCodeMap(), 180);
  }).observe($("#code-map-canvas"));
}

// ---- Zoom and pan ----
//
// One control for whichever view is showing. Wheel zoom keeps the point under the pointer still;
// the buttons zoom around the selected note or file when there is one, so the thing being read
// stays in front of you, and around the middle otherwise.

let zoomFrame = 0;
function repaintZoomed() {
  if (zoomFrame) return;
  zoomFrame = requestAnimationFrame(() => {
    zoomFrame = 0;
    if (boardView === "map") paintCodeMap();
    updateZoomControls();
  });
}

function currentZoom() {
  return boardView === "map" ? mapView.k : boardZoom;
}

function updateZoomControls() {
  const k = currentZoom();
  $("#board-zoom-level").textContent = `${Math.round(k * 100)}%`;
  for (const button of document.querySelectorAll("[data-board-zoom]")) {
    const action = button.dataset.boardZoom;
    button.disabled = action === "in" ? k >= ZOOM_MAX : k <= ZOOM_MIN;
  }
  $("#code-map-canvas").classList.toggle("is-zoomed", mapView.k > ZOOM_MIN);
  $("#assignment-board").classList.toggle("is-zoomed", boardZoom > ZOOM_MIN);
}

// `point` is in the map's own units (the SVG viewBox); omitted, it is the selected file or the middle.
function zoomMap(factor, point = null) {
  const layout = mapState.layout;
  if (!layout) return;
  let focus = point;
  if (!focus) {
    const selected = mapSelected ? layout.nodes.find((node) => node.path === mapSelected) : null;
    focus = selected
      ? { x: selected.x * mapView.k + mapView.tx, y: selected.y * mapView.k + mapView.ty }
      : { x: layout.width / 2, y: layout.height / 2 };
  }
  const k = factor === null ? ZOOM_MIN : clampZoom(mapView.k * factor);
  const worldX = (focus.x - mapView.tx) / mapView.k;
  const worldY = (focus.y - mapView.ty) / mapView.k;
  mapView = clampMapView({ k, tx: focus.x - worldX * k, ty: focus.y - worldY * k }, layout.width, layout.height);
  repaintZoomed();
}

// `client` is a pointer position on screen; omitted, it is the selected note or the middle. The
// board scrolls, so keeping a point still means re-rendering and then scrolling it back under you.
function zoomBoard(factor, client = null) {
  const board = $("#assignment-board");
  const canvas = board.querySelector(".assignment-board-canvas");
  const k = factor === null ? ZOOM_MIN : clampZoom(boardZoom * factor);
  if (k === boardZoom || !state?.selectedTask) return;
  const box = board.getBoundingClientRect();
  const anchor = !client && focusedAssignmentId
    ? board.querySelector(`[data-assignment-focus="${CSS.escape(String(focusedAssignmentId))}"]`)
    : null;
  const centre = (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };
  const before = anchor ? centre(anchor) : client || { x: box.left + board.clientWidth / 2, y: box.top + board.clientHeight / 2 };
  const view = { x: before.x - box.left, y: before.y - box.top };
  // Where that point sits in the canvas, as a fraction — the gaps grow, so this is the stable way to
  // say "the same place" when there is no single note to hold on to.
  const fraction = {
    x: (board.scrollLeft + view.x) / Math.max(1, canvas.offsetWidth),
    y: (board.scrollTop + view.y) / Math.max(1, canvas.offsetHeight),
  };
  boardZoom = k;
  renderAssignmentBoard(state.selectedTask);
  if (anchor?.isConnected) {
    const after = centre(anchor);
    board.scrollLeft += after.x - before.x;
    board.scrollTop += after.y - before.y;
  } else {
    board.scrollLeft = fraction.x * canvas.offsetWidth - view.x;
    board.scrollTop = fraction.y * canvas.offsetHeight - view.y;
  }
  updateZoomControls();
}

function zoomCurrent(factor, point = null) {
  if (boardView === "map") zoomMap(factor, point);
  else zoomBoard(factor, point);
}

function resetZoom() {
  const changed = boardZoom !== ZOOM_MIN;
  boardZoom = ZOOM_MIN;
  mapView = { ...MAP_VIEW_HOME };
  if (changed && state?.selectedTask) renderAssignmentBoard(state.selectedTask);
  if (mapState.layout) paintCodeMap();
  updateZoomControls();
}

$("#board-zoom").addEventListener("click", (event) => {
  const action = event.target.closest("[data-board-zoom]")?.dataset.boardZoom;
  if (action === "in") zoomCurrent(ZOOM_STEP);
  else if (action === "out") zoomCurrent(1 / ZOOM_STEP);
  else if (action === "reset") zoomCurrent(null);
});

// A wheel notch is ~100px of deltaY; line-mode wheels report lines, so they are scaled to match.
const wheelFactor = (event) => Math.exp(-event.deltaY * (event.deltaMode === 1 ? 16 : 1) * 0.0015);

// The map has nothing to scroll, so the wheel is its zoom.
$("#code-map-canvas").addEventListener("wheel", (event) => {
  const svg = $("#code-map-svg");
  const layout = mapState.layout;
  if (!layout || event.target.closest("#code-map-detail")) return;
  event.preventDefault();
  const rect = svg.getBoundingClientRect();
  zoomMap(wheelFactor(event), {
    x: (event.clientX - rect.left) * (layout.width / Math.max(1, rect.width)),
    y: (event.clientY - rect.top) * (layout.height / Math.max(1, rect.height)),
  });
}, { passive: false });

// The board scrolls, and a sixty-note plan needs its wheel for that — so it zooms on Ctrl/⌘+wheel,
// which is also what a trackpad pinch sends.
$("#assignment-board").addEventListener("wheel", (event) => {
  if (!(event.ctrlKey || event.metaKey) || !boardExpanded) return;
  event.preventDefault();
  zoomBoard(wheelFactor(event), { x: event.clientX, y: event.clientY });
}, { passive: false });

// Drag to pan, once zoomed. Nothing moves until the pointer has travelled a few pixels, and only
// then is the pointer captured — so an ordinary click still lands on the note or file under it,
// and a drag that ends over one does not also select it.
const PAN_THRESHOLD = 4;
function enablePan(surface, { canPan, begin, move }) {
  let drag = null;
  let swallowClick = false;
  surface.addEventListener("pointerdown", (event) => {
    // A drag that was cancelled never produces its click, so a stale "swallow" must not eat this one.
    swallowClick = false;
    if (event.button !== 0 || !canPan(event)) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: begin(), moved: false };
  });
  surface.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < PAN_THRESHOLD) return;
      drag.moved = true;
      surface.setPointerCapture(event.pointerId);
      surface.classList.add("is-panning");
    }
    move(drag.origin, dx, dy);
  });
  const end = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (drag.moved) {
      swallowClick = event.type === "pointerup";
      surface.classList.remove("is-panning");
      if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
    }
    drag = null;
  };
  surface.addEventListener("pointerup", end);
  surface.addEventListener("pointercancel", end);
  surface.addEventListener("click", (event) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.stopPropagation();
    event.preventDefault();
  }, true);
}

enablePan($("#code-map-canvas"), {
  canPan: (event) => mapView.k > ZOOM_MIN && Boolean(mapState.layout) && !event.target.closest("#code-map-detail"),
  begin: () => ({ ...mapView }),
  move: (origin, dx, dy) => {
    const layout = mapState.layout;
    const rect = $("#code-map-svg").getBoundingClientRect();
    const scale = layout.width / Math.max(1, rect.width);
    mapView = clampMapView({ k: origin.k, tx: origin.tx + dx * scale, ty: origin.ty + dy * scale }, layout.width, layout.height);
    repaintZoomed();
  },
});

enablePan($("#assignment-board"), {
  canPan: () => boardZoom > ZOOM_MIN,
  begin: () => {
    const board = $("#assignment-board");
    return { left: board.scrollLeft, top: board.scrollTop };
  },
  move: (origin, dx, dy) => {
    const board = $("#assignment-board");
    board.scrollLeft = origin.left - dx;
    board.scrollTop = origin.top - dy;
  },
});

function renderTask(task) {
  const taskChanged = renderedTaskId !== task.id;
  if (taskChanged) {
    focusedAssignmentId = null;
    // Another task is another picture; a zoom chosen for the last one means nothing here.
    boardZoom = ZOOM_MIN;
    mapView = { ...MAP_VIEW_HOME };
    updateZoomControls();
  }
  document.title = `DevTeam — ${task.title}`;
  $("#project-name").textContent = task.project_name;
  $("#task-status").textContent = task.status;
  $("#task-title").textContent = task.title;
  renderTaskDescription(task.description);
  $("#task-version").textContent = `v${task.version}`;
  const eventList = $("#event-list");
  const nearBottom = eventList.scrollHeight - eventList.scrollTop - eventList.clientHeight < 220;
  renderedTaskId = task.id;
  eventLookup = new Map(task.events.map((event) => [event.id, event]));
  if (replyTo && !eventLookup.has(replyTo.id)) { replyTo = null; }
  renderReplyContext();
  renderTimeline(task, { taskChanged, wasNearBottom: nearBottom });
  if (taskChanged) restoreMessageDraft(task.id);
  renderMembers(task);
  const openAssignments = task.assignments.filter((item) => ["queued", "claimed"].includes(item.status)).length;
  // Collapsed, this line is the whole board. It has to say enough that nobody opens it to find out
  // that nothing has changed — which a bare count of open notes never did, since a board of six
  // blocked notes counted zero.
  $("#board-summary").textContent = boardSummary(task.assignments, task.status, buildFlowModel(task.assignments || [], { taskStatus: task.status }));
  renderCurrentWork(task);
  renderAssignmentBoard(task);
  // A different task means a different set of touched files, and possibly a different project.
  if (boardView === "map") loadCodeMap(task.id, { force: taskChanged });
  renderRegressions(task);
  renderBlackboard(task);
  const approvals = task.approvals.length;
  $("#approval-label").textContent = `${approvals} / ${task.required_approvals}`;
  $("#approval-progress").style.width = `${Math.min(100, approvals / task.required_approvals * 100)}%`;
  const remaining = Math.max(0, task.required_approvals - approvals);
  const connectedCount = state.agents.filter((agent) => agent.status !== "disconnected").length;
  const acceptedEvent = task.status === "accepted" && task.events.slice().reverse().find((e) => e.type === "task.accepted");
  const humanOverride = acceptedEvent && acceptedEvent.metadata && acceptedEvent.metadata.humanOverride;
  let consensusCopy;
  if (task.status === "accepted") {
    consensusCopy = humanOverride
      ? "You accepted this task directly. This was not independent agent consensus."
      : "The current version has team consensus.";
  } else if (task.status === "blocked") {
    consensusCopy = "Task is blocked. Use Resume to unblock and continue work.";
  } else {
    consensusCopy = `${remaining} independent approval${remaining === 1 ? "" : "s"} still needed.`;
    if (remaining > 0 && connectedCount < remaining) {
      consensusCopy += ` Only ${connectedCount} agent${connectedCount === 1 ? "" : "s"} connected — connect ${remaining - connectedCount} more (each agent approves once) to reach consensus.`;
    }
  }
  $("#consensus-copy").textContent = consensusCopy;
  const canAccept = openAssignments === 0 && ["review"].includes(task.status);
  $("#accept-task").classList.toggle("hidden", !canAccept);
}


function renderTaskDescription(description) {
  const element = $("#task-description");
  const button = $("#open-task-brief");
  const text = String(description || "");
  const long = text.length > 220 || text.split("\n").length > 3;
  const preview = long ? text.replace(/\s+/g, " ").trim() : text;
  if (element.textContent !== preview) element.textContent = preview;
  element.classList.toggle("is-long", long);
  element.classList.toggle("collapsed", long);
  button.classList.toggle("hidden", !long);
  $("#task-brief-content").textContent = text;
  $("#task-brief-title").textContent = state?.selectedTask?.title || "Task brief";
}

function resizeMessageField(field) {
  field.style.height = "auto";
  const maxHeight = Number.parseFloat(getComputedStyle(field).maxHeight) || 130;
  const height = Math.min(field.scrollHeight, maxHeight);
  field.style.height = `${height}px`;
  field.style.overflowY = field.scrollHeight > maxHeight ? "auto" : "hidden";
}

// Who belongs to this task room and in what role — so the human can see the room's membership,
// not just who is globally online. Contributors claim work; observers watch and review.
function renderMembers(task) {
  const container = $("#room-members");
  if (!container) return;
  const members = task.members || [];
  container.classList.toggle("hidden", members.length === 0);
  if (!members.length) { container.innerHTML = ""; return; }
  container.innerHTML = `<div class="members-head">In this room</div>` + members.map((member) => {
    const dead = member.status === "disconnected";
    const forget = dead && member.agent_id
      ? `<button class="row-delete" data-forget-agent="${member.agent_id}" data-forget-name="${escapeHtml(member.agent_name)}" title="Remove this agent from DevTeam" aria-label="Remove ${escapeHtml(member.agent_name)}">×</button>`
      : "";
    return `<div class="member-row agent-color-${agentColorIndex(member.agent_name)} ${dead ? "gone" : ""}"><span class="agent-swatch"></span><span class="member-name">${escapeHtml(member.agent_name)}</span><span class="member-role ${member.role === "observer" ? "observer" : ""}">${escapeHtml(member.role)}</span><span class="member-status">${escapeHtml(member.status)}</span>${forget}</div>`;
  }).join("");
}

// The team's shared working memory: versioned keys with provenance. A long value is collapsed.
function renderBlackboard(task) {
  renderMemoryScope("blackboard", task.blackboard || []);
  renderMemoryScope("project-blackboard", task.projectBlackboard || []);
  renderMemoryHealth(task);
  renderCodeGraph(task);
  renderKnowledge(task);
}

function renderMemoryHealth(task) {
  const target = $("#memory-health-summary");
  if (!target) return;
  const health = task.memoryHealth || {};
  const brief = health.brief || {};
  const limit = Number(brief.limitBytes || 32 * 1024);
  const bytes = brief.bytes == null ? null : Number(brief.bytes);
  const percentage = bytes == null || !limit ? 0 : Math.min(100, Math.round((bytes / limit) * 100));
  const formatBytes = (value) => value == null ? "Not generated yet" : `${(Number(value) / 1024).toFixed(1)} KiB`;
  $("#brief-budget-status").textContent = bytes == null ? `${Math.round(limit / 1024)} KiB limit` : `${percentage}% used`;
  const omitted = Object.entries(brief.omitted || {}).filter(([, count]) => Number(count) > 0);
  const lifecycle = health.knowledge || {};
  const errors = [health.knowledgeError?.message, health.graphError?.message].filter(Boolean);
  target.innerHTML = `
    <div class="brief-meter" role="meter" aria-label="Briefing byte use" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${bytes || 0}"><span style="width:${percentage}%"></span></div>
    <div class="memory-health-grid">
      <span><strong>${escapeHtml(formatBytes(bytes))}</strong> of ${escapeHtml(formatBytes(limit))}</span>
      <span><strong>${brief.truncated == null ? "Pending" : brief.truncated ? "Bounded" : "Complete"}</strong> context</span>
      <span><strong>${Number(lifecycle.stale || 0)}</strong> stale notes</span>
      <span><strong>${Number(lifecycle.disputed || 0)}</strong> disputed notes</span>
    </div>
    ${omitted.length ? `<p class="memory-omissions"><strong>Fetch on demand:</strong> ${omitted.map(([key, count]) => `${escapeHtml(key)} ${Number(count)}`).join(" · ")}</p>` : ""}
    ${brief.generatedAt ? `<small>Last ${escapeHtml(brief.delivery || "requested")} brief ${relativeTime(brief.generatedAt)}.</small>` : `<small>The first agent briefing will populate actual usage.</small>`}
    ${health.graphIndexedAt ? `<small>CodeGraph indexed ${relativeTime(health.graphIndexedAt)}${health.graphTruncated ? " at its safety cap" : ""}.</small>` : ""}
    ${errors.map((message) => `<p class="knowledge-error">${escapeHtml(message)}</p>`).join("")}
  `;
}

function renderCodeGraph(task) {
  const section = $("#codegraph-section");
  if (!section) return;
  const graph = task.codeGraph || {};
  section.classList.toggle("hidden", !graph.automated && !graph.moduleCount && !graph.error);
  $("#codegraph-count").textContent = graph.moduleCount || 0;
  const warning = graph.truncated ? `<p class="codegraph-warning">Showing the deterministic 3,000-module safety cap.</p>` : "";
  const error = graph.error ? `<p class="knowledge-error">Index needs attention: ${escapeHtml(graph.error.message)}</p>` : "";
  $("#codegraph-summary").innerHTML = `${error}<div class="codegraph-metrics"><span><strong>${Number(graph.moduleCount || 0)}</strong> modules</span><span><strong>${Number(graph.edgeCount || 0)}</strong> edges</span></div>${warning}<small>${graph.indexedAt ? `Indexed ${relativeTime(graph.indexedAt)}` : "Ready — indexing starts automatically."}</small>${graph.path ? `<code title="${escapeHtml(graph.path)}">${escapeHtml(graph.path)}</code>` : ""}`;
}

function renderKnowledge(task) {
  const section = $("#knowledge-section");
  if (!section) return;
  const notes = task.knowledge || [];
  // The notes the team can rely on, and nothing else. The rest are one quiet line: set aside, not
  // hidden, and not worth a filter nobody has a reason to open.
  const visible = notes.filter((note) => ["verified", "inferred"].includes(note.status));
  const setAside = ["archived", "disputed", "stale"]
    .map((status) => [status, notes.filter((note) => note.status === status).length])
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`);
  const setAsideLine = $("#knowledge-set-aside");
  setAsideLine.classList.toggle("hidden", !setAside.length);
  setAsideLine.textContent = setAside.length ? `Set aside: ${setAside.join(" · ")}` : "";
  const notesById = new Map(notes.map((note) => [note.id, note]));
  section.classList.toggle("hidden", !task.knowledgeVault?.automated && notes.length === 0);
  $("#knowledge-count").textContent = visible.length;
  const error = task.knowledgeVault?.error;
  $("#knowledge-list").innerHTML = `${error ? `<p class="knowledge-error">Export needs attention: ${escapeHtml(error.message)}</p>` : ""}${visible.slice(0, 10).map((note) => `
    <div class="knowledge-note">
      <div><span class="knowledge-category">${escapeHtml(note.category)}</span><span class="knowledge-status ${escapeHtml(note.status)}">${escapeHtml(note.status)}</span></div>
      <strong>${escapeHtml(note.title)}</strong>
      <small>${escapeHtml(note.link)} · r${note.revision} · ${relativeTime(note.updated_at)}</small>
      ${note.stale_reason ? `<small class="knowledge-reason">${escapeHtml(note.stale_reason)}</small>` : ""}
      ${note.superseded_by ? `<small class="knowledge-reason">Superseded by ${escapeHtml(notesById.get(note.superseded_by)?.title || note.superseded_by)}</small>` : ""}
    </div>`).join("") || '<p class="memory-scope">Nothing written down yet. Notes are never captured automatically — an agent has to record one.</p>'}`;
}

function renderMemoryScope(prefix, notes) {
  const section = $(`#${prefix}-section`);
  if (!section) return;
  section.classList.toggle("hidden", notes.length === 0);
  $(`#${prefix}-count`).textContent = notes.length;
  $(`#${prefix}-list`).innerHTML = notes.map((note) => {
    const value = String(note.value ?? "");
    const preview = value.length > 240 ? `${value.slice(0, 240)}…` : value;
    return `<details class="note"><summary><span class="note-key">${escapeHtml(note.key)}</span><span class="note-meta">v${note.version} · ${escapeHtml(note.updatedBy || "?")} · ${relativeTime(note.updatedAt)}</span></summary><pre class="note-body">${escapeHtml(preview)}</pre></details>`;
  }).join("");
}

function renderReplyContext() {
  const element = $("#reply-context");
  if (!element) return;
  if (!replyTo) { element.classList.add("hidden"); element.innerHTML = ""; return; }
  element.classList.remove("hidden");
  element.innerHTML = `<span class="reply-quote">↳ Replying to ${escapeHtml(replyTo.name)}: ${escapeHtml(replyTo.snippet)}</span><button type="button" class="reply-cancel" title="Cancel reply" aria-label="Cancel reply">×</button>`;
}

function renderAgents() {
  renderAgentList();
  const connected = state.agents.filter((agent) => agent.status !== "disconnected");
  populateMessageTargets(connected);
}


// Presence + unread badges + re-ping list. Split out so a lightweight timer can
// refresh relative "last seen" times without disturbing the message composer.
function renderAgentList() {
  if (!state) return;
  const connected = state.agents.filter((agent) => agent.status !== "disconnected");
  $("#online-count").textContent = `${connected.length} online`;
  $("#agent-list").innerHTML = connected.map((agent) => {
    const unread = agent.pending_messages > 0
      ? `<span class="unread-badge" title="${agent.pending_messages} message${agent.pending_messages === 1 ? "" : "s"} not delivered yet">${agent.pending_messages}</span>`
      : "";
    // An unresponsive agent that has genuinely left keeps lingering as "online" (it holds its claim
    // on purpose). Offer a Remove so the human can clear the leftover session id on the spot.
    const forget = agent.status === "unresponsive"
      ? `<button class="row-delete" data-forget-agent="${agent.id}" data-forget-name="${escapeHtml(agent.name)}" title="Remove this unresponsive agent from DevTeam" aria-label="Remove ${escapeHtml(agent.name)}">×</button>`
      : "";
    // What this session says it is running, in the words it reported at join.
    const running = [agent.current_model, agent.current_effort].filter(Boolean).join(" · ");
    const runtime = running ? `<small class="runtime-profile">${escapeHtml(running)}</small>` : "";
    return `<div class="agent agent-color-${agentColorIndex(agent.name)}"><div class="avatar">${initials(agent.name)}</div><div class="agent-info"><strong>${escapeHtml(agent.name)}${unread}</strong><small>${escapeHtml(agent.provider)} · ${escapeHtml(agent.status)} · session ${Number(agent.session_generation || 1)}</small>${runtime}<small class="activity">${escapeHtml(activityLine(agent))}</small></div><span class="agent-actions"><span class="agent-status ${agent.status} ${freshness(agent.last_seen)}" title="${escapeHtml(agent.status)} · seen ${relativeTime(agent.last_seen)}"></span>${forget}</span></div>`;
  }).join("") || `<p class="hint">No agents connected. Copy the MCP setup, then invoke <code>$devteam</code> in an AI desktop.</p>`;
  renderReconnectList();
}

function renderReconnectList() {
  const container = $("#reconnect-list");
  if (!container) return;
  const cutoff = Date.now() - 60 * 60 * 1000;
  const recent = state.agents
    .filter((agent) => agent.status === "disconnected" && agent.disconnected_at && new Date(agent.disconnected_at).getTime() > cutoff)
    .sort((a, b) => new Date(b.disconnected_at) - new Date(a.disconnected_at))
    .slice(0, 3);
  container.innerHTML = recent.length
    ? `<div class="reconnect-head">Recently left</div>` + recent.map((agent) => `<div class="reconnect-row agent-color-${agentColorIndex(agent.name)}"><span class="agent-swatch"></span><div class="agent-info"><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.provider)} · left ${relativeTime(agent.disconnected_at)}</small></div><button class="reconnect-btn" data-reconnect="${escapeHtml(agent.name)}" title="Copy a reconnect prompt to paste into ${escapeHtml(agent.name)}'s desktop">Re-ping</button></div>`).join("")
    : "";
}

function agentInvite(name = "your agent") {
  const task = state?.selectedTask;
  if (!task) return "Use $devteam to join the local DevTeam.";
  return `Use $devteam as ${name} and join task "${task.title}" with taskId ${task.id}. If this is the same returning conversation, resume the prior DevTeam session so missed messages replay before claiming work.`;
}

function addAttachments(files) {
  for (const file of files) {
    if (!ATTACHMENT_TYPES.has(file.type)) { toast(`${file.name}: unsupported file type`); continue; }
    if (!file.size || file.size > MAX_ATTACHMENT_BYTES) { toast(`${file.name}: file must be 10 MB or smaller`); continue; }
    if (pendingAttachments.length >= 6) { toast("Attach up to 6 files per message"); break; }
    pendingAttachments.push({ id: crypto.randomUUID(), file, objectUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null });
  }
  renderPendingAttachments();
}

function renderPendingAttachments() {
  const container = $("#attachment-preview");
  container.classList.toggle("hidden", pendingAttachments.length === 0);
  container.innerHTML = pendingAttachments.map((item) => `<div class="pending-attachment">${item.objectUrl ? `<img src="${escapeHtml(item.objectUrl)}" alt="">` : `<span>PDF</span>`}<strong title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</strong><button type="button" data-remove-attachment="${item.id}" aria-label="Remove ${escapeHtml(item.file.name)}">×</button></div>`).join("");
}

function clearPendingAttachments() {
  for (const item of pendingAttachments) if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
  pendingAttachments = [];
  renderPendingAttachments();
}

async function uploadAttachment(file, taskId) {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), "X-File-Type": file.type },
    body: file,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Attachment upload failed (${response.status})`);
  return body;
}

function populateMessageTargets(connected) {
  const select = $("#message-target");
  if (select) {
    const savedTarget = selectedTaskId ? readDraft(selectedTaskId)?.target : null;
    const previous = savedTarget || select.value || "all";
    const options = [`<option value="all">All agents${connected.length ? ` (${connected.length})` : ""}</option>`]
      .concat(connected.map((agent) => `<option value="${escapeHtml(agent.name)}">${escapeHtml(agent.name)} · ${escapeHtml(agent.provider)}</option>`));
    select.innerHTML = options.join("");
    select.value = previous === "all" || connected.some((agent) => agent.name === previous) ? previous : "all";
  }
  const hint = $("#composer-hint");
  if (hint) hint.textContent = connected.length
    ? "Agents in the room get this on their next check; one that is offline gets it when it rejoins."
    : "No agent is connected — each one gets this when it joins the room.";
}


document.addEventListener("click", async (event) => {
  const chip = event.target.closest("[data-board-chip]");
  if (chip && state?.selectedTask) {
    focusedAssignmentId = chip.dataset.boardChip;
    applyBoardMode(true);
    renderAssignmentBoard(state.selectedTask);
    return;
  }
  const assignmentButton = event.target.closest("[data-assignment-focus]");
  if (assignmentButton && state?.selectedTask) {
    focusedAssignmentId = focusedAssignmentId === assignmentButton.dataset.assignmentFocus ? null : assignmentButton.dataset.assignmentFocus;
    renderAssignmentBoard(state.selectedTask);
    return;
  }
  if (event.target.closest("[data-assignment-close]")) {
    focusedAssignmentId = null;
    if (state?.selectedTask) renderAssignmentBoard(state.selectedTask);
    return;
  }
  const retrySend = event.target.closest("[data-retry-send]");
  if (retrySend) {
    const pending = pendingSends.find((item) => item.id === retrySend.dataset.retrySend);
    if (pending) await processPendingSend(pending);
    return;
  }
  const searchResult = event.target.closest("[data-search-task]");
  if (searchResult) {
    const taskId = searchResult.dataset.searchTask || state.tasks.find((task) => task.project_id === searchResult.dataset.searchProject)?.id;
    if (!taskId) { toast("That knowledge note is not attached to a task yet"); return; }
    selectedTaskId = taskId;
    selectedProjectId = searchResult.dataset.searchProject || null;
    pendingJumpEventId = Number(searchResult.dataset.searchEvent) || null;
    $("#search-dialog").close();
    await refresh();
    return;
  }
  const removeAttachment = event.target.closest("[data-remove-attachment]");
  if (removeAttachment) {
    const index = pendingAttachments.findIndex((item) => item.id === removeAttachment.dataset.removeAttachment);
    if (index >= 0) {
      const [removed] = pendingAttachments.splice(index, 1);
      if (removed.objectUrl) URL.revokeObjectURL(removed.objectUrl);
      renderPendingAttachments();
    }
    return;
  }
  const dialogButton = event.target.closest("[data-dialog]");
  if (dialogButton) {
    $("#" + dialogButton.dataset.dialog).showModal();
    // The checklists on offer belong to the project, so re-read them as the dialog opens rather
    // than showing whatever the last project had.
    if (dialogButton.dataset.dialog === "task-dialog") loadDomainChoices($("#project-select").value || selectedProjectId);
  }
  if (event.target.closest(".close")) event.target.closest("dialog").close();
  const deleteTaskButton = event.target.closest("[data-delete-task]");
  if (deleteTaskButton) {
    const task = state.tasks.find((item) => item.id === deleteTaskButton.dataset.deleteTask);
    if (!task || !confirm(`Delete the task history “${task.title}” from DevTeam?\n\nMessages, assignments, and approvals for this task will be deleted. Project files will not be touched.`)) return;
    try {
      await api(`/api/tasks/${task.id}`, { method: "DELETE", body: JSON.stringify({ confirmTaskId: task.id }) });
      storageSet(draftKey(task.id), null);
      storageSet(readKey(task.id), null);
      const currentTask = state.tasks.find((item) => item.id === selectedTaskId && item.id !== task.id);
      const nextTask = state.tasks.find((item) => item.project_id === task.project_id && item.id !== task.id);
      selectedTaskId = currentTask?.id || nextTask?.id || null;
      selectedProjectId = task.project_id;
      syncTaskUrl();
      await refresh();
      toast("Task history deleted; project files were untouched");
    } catch (error) { toast(error.message); }
    return;
  }
  const deleteProjectButton = event.target.closest("[data-delete-project]");
  if (deleteProjectButton) {
    const project = state.projects.find((item) => item.id === deleteProjectButton.dataset.deleteProject);
    if (!project || !confirm(`Remove “${project.name}” from DevTeam?\n\nThis deletes ${project.task_count} task ${project.task_count === 1 ? "history" : "histories"} from DevTeam. Files in ${project.root} will not be touched.`)) return;
    try {
      await api(`/api/projects/${project.id}`, { method: "DELETE", body: JSON.stringify({ confirmName: project.name }) });
      const currentProject = state.projects.find((item) => item.id === selectedProjectId && item.id !== project.id);
      const nextProject = currentProject || state.projects.find((item) => item.id !== project.id);
      selectedProjectId = nextProject?.id || null;
      const currentTask = state.tasks.find((item) => item.id === selectedTaskId && item.project_id === selectedProjectId);
      selectedTaskId = currentTask?.id || state.tasks.find((item) => item.project_id === selectedProjectId)?.id || null;
      syncTaskUrl();
      await refresh();
      toast("Project removed from DevTeam; files were untouched");
    } catch (error) { toast(error.message); }
    return;
  }
  const forgetAgentButton = event.target.closest("[data-forget-agent]");
  if (forgetAgentButton) {
    const name = forgetAgentButton.dataset.forgetName || "this agent";
    if (!confirm(`Remove ${name} from DevTeam?\n\nThis clears the leftover session id so it stops showing here. Any work it still holds returns to the queue. It can reconnect any time with $devteam.`)) return;
    try {
      await api(`/api/agents/${forgetAgentButton.dataset.forgetAgent}`, { method: "DELETE", body: JSON.stringify({}) });
      await refresh();
      toast(`${name} removed from DevTeam`);
    } catch (error) { toast(error.message); }
    return;
  }
  const editProjectButton = event.target.closest("[data-edit-project]");
  if (editProjectButton) {
    const project = state.projects.find((item) => item.id === editProjectButton.dataset.editProject);
    if (!project) return;
    const form = $("#project-edit-form");
    form.dataset.projectId = project.id;
    form.elements.name.value = project.name;
    form.elements.root.value = project.root;
    const team = project.team || {};
    for (const role of ["planner", "implementer", "reviewer"]) form.elements[`team_${role}`].value = (team[role] || []).join(", ");
    form.elements.soloReview.checked = Boolean(project.solo_review);
    // Suggest the names agents have actually connected under, since that is what the team matches.
    $("#known-agent-names").innerHTML = [...new Set((state.agents || []).map((agent) => agent.name))]
      .map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
    $("#project-edit-dialog").showModal();
    return;
  }
  if (event.target.closest(".reply-cancel")) { replyTo = null; renderReplyContext(); return; }
  const replyButton = event.target.closest("[data-reply]");
  if (replyButton) {
    const parent = eventLookup.get(Number(replyButton.dataset.reply));
    if (parent) {
      replyTo = { id: parent.id, name: eventIsHuman(parent) ? "You" : eventAuthorName(parent), snippet: (parent.message || "").slice(0, 80) };
      renderReplyContext();
      $("#message-form").elements.message.focus();
    }
    return;
  }
  const cardAction = event.target.closest("[data-card-action]");
  if (cardAction) { openCardDialog(cardAction.dataset.cardAction, cardAction.dataset.cardId); return; }
  const releaseButton = event.target.closest("[data-release]");
  if (releaseButton) {
    const title = releaseButton.dataset.releaseTitle;
    if (!confirm(`Force-release the write lease for “${title}”?\n\nOnly do this if the agent has genuinely crashed or is stuck — a still-running writer would lose its lease. Type nothing; this confirms the exact title for you.`)) return;
    try { await api(`/api/assignments/${releaseButton.dataset.release}/force-release`, { method: "POST", body: JSON.stringify({ confirmTitle: title }) }); await refresh(); toast("Write lease released back to the queue"); }
    catch (error) { toast(error.message); }
    return;
  }
  const sendBackButton = event.target.closest("[data-send-back]");
  if (sendBackButton) {
    const title = sendBackButton.dataset.sendBackTitle;
    const summary = prompt(`Send “${title}” back to its author for changes.\n\nWhat needs to change? (one line)`);
    if (summary === null || !summary.trim()) return;
    const detail = prompt("Specific findings, one per line (optional). The author is handed these when it picks the work back up.") || "";
    const findings = detail.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 50);
    try {
      const result = await api(`/api/tasks/${state.selectedTask.id}/assignments/${sendBackButton.dataset.sendBack}/request-changes`, {
        method: "POST", body: JSON.stringify({ summary: summary.trim(), findings }),
      });
      await refresh();
      toast(result.routedTo ? `Sent back to ${result.routedTo}` : "Sent back to the queue");
    } catch (error) { toast(error.message); }
    return;
  }
  const reconnectButton = event.target.closest("[data-reconnect]");
  if (reconnectButton) {
    const name = reconnectButton.dataset.reconnect;
    const promptText = agentInvite(name);
    try { await navigator.clipboard.writeText(promptText); toast(`Copied — paste into ${name}'s desktop to reconnect`); }
    catch { toast(`Paste into ${name}'s desktop: ${promptText}`); }
    return;
  }
  const taskButton = event.target.closest("[data-task]");
  if (taskButton) { clearPendingAttachments(); selectedTaskId = taskButton.dataset.task; syncTaskUrl(); await refresh(); }
  const projectButton = event.target.closest("[data-project]");
  if (projectButton) { clearPendingAttachments(); selectedProjectId = projectButton.dataset.project; const first = state.tasks.find((task) => task.project_id === selectedProjectId); selectedTaskId = first?.id || null; syncTaskUrl(); await refresh(); }
});

// Domain checkboxes come from the server's live list, which is the checklists directory: a domain
// exists because checklists/<name>.md exists. That is also how you add one — there is no button,
// because a name with no file promises the team a check that cannot happen.
//
// Each choice shows how many lines its file holds. A count of zero means the file has been deleted
// and only older tasks still carry the name; it is dimmed rather than hidden so those tasks stay
// editable. Empty until the server answers — there is no built-in list to fall back on, because a
// name with no file behind it is exactly what this picker must not show.
let domainChoices = [];
function renderDomainPickers() {
  for (const picker of document.querySelectorAll("[data-domain-picker]")) {
    const checked = new Set([...picker.querySelectorAll('input[name="domains"]:checked')].map((box) => box.value));
    picker.querySelectorAll(".domain-choice, .domain-empty").forEach((node) => node.remove());
    if (!domainChoices.length) {
      const note = document.createElement("span");
      note.className = "domain-empty hint";
      note.textContent = "No checklists yet — write checklists/<name>.md to add a domain.";
      picker.append(note);
      continue;
    }
    for (const domain of domainChoices) {
      const label = document.createElement("label");
      const items = Number(domain.checklistItems) || 0;
      label.className = items ? "domain-choice" : "domain-choice domain-choice-empty";
      label.title = items
        ? `checklists/${domain.name}.md — ${items} item(s), shown to reviewers of this work`
        : domain.hasFile
          ? `checklists/${domain.name}.md exists but has no items yet; reviewers get nothing extra`
          : `checklists/${domain.name}.md is gone; only older tasks still use this name`;
      const box = document.createElement("input");
      box.type = "checkbox"; box.name = "domains"; box.value = domain.name; box.checked = checked.has(domain.name);
      const count = document.createElement("span");
      count.className = "domain-count";
      count.textContent = items ? ` ${items}` : " —";
      label.append(box, document.createTextNode(domain.name), count);
      picker.append(label);
    }
  }
}
// The list is the selected project's own `checklists/` folder when it has one, so it reloads when
// the dialog's project changes rather than once at boot.
async function loadDomainChoices(projectId = selectedProjectId) {
  try {
    const domains = await api(`/api/domains${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
    // An empty answer is a real answer: the checklists directory has no files yet.
    if (Array.isArray(domains)) {
      domainChoices = domains.map((domain) => ({
        name: domain.name,
        checklistItems: Number(domain.checklistItems) || 0,
        hasFile: Boolean(domain.checklistFile),
      }));
    }
  } catch { /* the server is unreachable; show nothing rather than names that may not exist */ }
  renderDomainPickers();
}
renderDomainPickers();
loadDomainChoices();
$("#project-select").addEventListener("change", (event) => loadDomainChoices(event.target.value || null));
const taskDomains = (task) => {
  if (Array.isArray(task?.domains)) return task.domains;
  try { return JSON.parse(task?.domains || "[]"); } catch { return []; }
};

$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const formData = new FormData(event.target);
    const values = Object.fromEntries(formData); values.requiredApprovals = Number(values.requiredApprovals);
    values.domains = formData.getAll("domains");
    const task = await api("/api/tasks", { method: "POST", body: JSON.stringify(values) });
    selectedTaskId = task.id; selectedProjectId = task.project_id; event.target.reset(); event.target.closest("dialog").close(); await refresh(); toast("Task created — use Invite agent to start its room");
  } catch (error) { toast(error.message); }
});

$("#project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const project = await api("/api/projects", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
    selectedProjectId = project.id; event.target.reset(); event.target.closest("dialog").close(); await refresh(); toast("Project added");
  } catch (error) { toast(error.message); }
});









function openTaskEditor() {
  const task = state?.selectedTask;
  if (!task) return;
  const form = $("#task-edit-form");
  form.dataset.taskId = task.id;
  form.elements.title.value = task.title;
  form.elements.description.value = task.description;
  form.elements.requiredApprovals.value = String(task.required_approvals);
  const selected = new Set(taskDomains(task));
  for (const box of form.querySelectorAll('input[name="domains"]')) box.checked = selected.has(box.value);
  $("#task-edit-dialog").showModal();
}

// One dialog for fixing a card. Reopen: who takes it and what they should know. Edit: its title,
// description and addressee. Close: why, and optionally which card replaces it.
function openCardDialog(mode, cardId) {
  const task = state?.selectedTask;
  const item = task?.assignments?.find((candidate) => String(candidate.id) === String(cardId));
  if (!item) return;
  const form = $("#card-form");
  form.dataset.mode = mode;
  form.dataset.cardId = item.id;
  $("#card-dialog-eyebrow").textContent = { reopen: "REOPEN", edit: "EDIT CARD", close: "CLOSE CARD" }[mode];
  $("#card-dialog-title").textContent = item.title;
  for (const section of form.querySelectorAll("[data-card-mode]")) {
    section.classList.toggle("hidden", !section.dataset.cardMode.split(" ").includes(mode));
  }
  form.elements.title.value = item.title;
  form.elements.description.value = item.description || "";
  form.elements.note.value = "";
  form.elements.reason.value = "";
  const names = [...new Set([
    ...Object.entries(task.team || {}).filter(([key]) => key !== "soloReview").flatMap(([, list]) => list),
    ...(state.agents || []).map((agent) => agent.name),
    ...(item.target_agent_name ? [item.target_agent_name] : []),
  ])].filter(Boolean);
  form.elements.target.innerHTML = `<option value="">Anyone who may take it</option>${names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}`;
  form.elements.target.value = item.target_agent_name || "";
  const others = task.assignments.filter((candidate) => candidate.id !== item.id && ["queued", "claimed", "done"].includes(candidate.status));
  form.elements.replacedBy.innerHTML = `<option value="">No replacement</option>${others.map((candidate) => `<option value="${escapeHtml(candidate.id)}">${escapeHtml(candidate.title)}</option>`).join("")}`;
  $("#card-submit").textContent = { reopen: "Reopen card", edit: "Save card", close: "Close card" }[mode];
  $("#card-submit").classList.toggle("danger-fill", mode === "close");
  $("#card-dialog").showModal();
}

$("#card-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const { mode, cardId } = form.dataset;
  const taskId = state?.selectedTask?.id;
  if (!taskId || !cardId) return;
  const base = `/api/tasks/${taskId}/assignments/${cardId}`;
  try {
    if (mode === "reopen") {
      await api(`${base}/reopen`, { method: "POST", body: JSON.stringify({ note: form.elements.note.value, targetAgentName: form.elements.target.value }) });
    } else if (mode === "edit") {
      await api(base, { method: "PATCH", body: JSON.stringify({ title: form.elements.title.value, description: form.elements.description.value, targetAgentName: form.elements.target.value }) });
    } else {
      if (!form.elements.reason.value.trim()) { toast("Say why this card is being closed"); return; }
      await api(`${base}/close`, { method: "POST", body: JSON.stringify({ reason: form.elements.reason.value, replacedBy: form.elements.replacedBy.value || null }) });
    }
    form.closest("dialog").close();
    await refresh();
    toast({ reopen: "Card reopened", edit: "Card saved", close: "Card closed" }[mode]);
  } catch (error) { toast(error.message); }
});

$("#edit-task").addEventListener("click", openTaskEditor);
$("#edit-task-from-brief").addEventListener("click", () => {
  $("#task-brief-dialog").close();
  openTaskEditor();
});

$("#task-edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const taskId = form.dataset.taskId;
  if (!taskId) return;
  const formData = new FormData(form);
  const values = Object.fromEntries(formData);
  try {
    await api(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ title: values.title, description: values.description, requiredApprovals: Number(values.requiredApprovals), domains: formData.getAll("domains") }) });
    form.closest("dialog").close(); await refresh(); toast("Task updated");
  } catch (error) { toast(error.message); }
});

$("#project-edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const projectId = form.dataset.projectId;
  if (!projectId) return;
  const values = Object.fromEntries(new FormData(form));
  const names = (value) => String(value || "").split(",").map((name) => name.trim()).filter(Boolean);
  const team = { planner: names(values.team_planner), implementer: names(values.team_implementer), reviewer: names(values.team_reviewer) };
  try {
    await api(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ name: values.name, root: values.root, team, soloReview: form.elements.soloReview.checked }) });
    form.closest("dialog").close(); await refresh(); toast("Project updated");
  } catch (error) { toast(error.message); }
});

async function processPendingSend(item) {
  if (messageSending) { toast("Wait for the current message to finish sending"); return; }
  const sendButton = $("#message-form .send");
  messageSending = true;
  item.status = "sending";
  item.error = "";
  sendButton.disabled = true;
  if (state?.selectedTask?.id === item.taskId) renderTimeline(state.selectedTask, { wasNearBottom: true });
  try {
    item.uploaded ||= await Promise.all(item.files.map((file) => uploadAttachment(file, item.taskId)));
    const markers = item.uploaded.map((attachment) => `[[devteam-attachment ${JSON.stringify(attachment)}]]`);
    const body = { message: [item.message, ...markers].filter(Boolean).join("\n"), target: item.target };
    if (item.replyTo) body.replyTo = item.replyTo;
    await api(`/api/tasks/${item.taskId}/messages`, { method: "POST", body: JSON.stringify(body) });
    pendingSends = pendingSends.filter((pending) => pending.id !== item.id);
    const stored = readDraft(item.taskId);
    if (!stored || stored.message === item.message) clearMessageDraft(item.taskId);
    try { await refresh(); }
    catch (error) { toast(`Message sent, but the timeline refresh failed: ${error.message}`); }
  } catch (error) {
    item.status = "failed";
    item.error = error.message;
    if (!readDraft(item.taskId)) storageSet(draftKey(item.taskId), JSON.stringify({ message: item.message, target: item.target, savedAt: new Date().toISOString() }));
    if (state?.selectedTask?.id === item.taskId) {
      updateDraftStatus("Failed message kept for retry");
      renderTimeline(state.selectedTask, { wasNearBottom: true });
    }
    toast(`Message failed: ${error.message}`);
  } finally {
    messageSending = false;
    sendButton.disabled = false;
  }
}

$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (!selectedTaskId || messageSending) return;
  const field = event.target.elements.message;
  const message = field.value.trim();
  if (!message && pendingAttachments.length === 0) { toast("Write a message or attach a file"); return; }
  const item = {
    id: crypto.randomUUID(),
    taskId: selectedTaskId,
    message,
    target: event.target.elements.target?.value || "all",
    replyTo: replyTo?.id || null,
    files: pendingAttachments.map((attachment) => attachment.file),
    uploaded: null,
    status: "sending",
    error: "",
  };
  pendingSends.push(item);
  field.value = "";
  resizeMessageField(field);
  clearPendingAttachments();
  updateDraftStatus("Sending…");
  replyTo = null;
  renderReplyContext();
  await processPendingSend(item);
});

$("#message-form").addEventListener("keydown", (event) => {
  if (event.target.tagName === "TEXTAREA" && event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    event.target.form.requestSubmit();
  }
});

$("#message-form").elements.message.addEventListener("input", (event) => {
  resizeMessageField(event.target);
  saveMessageDraft();
});
$("#message-target").addEventListener("change", () => saveMessageDraft());

$("#attachment-input").addEventListener("change", (event) => {
  addAttachments(event.target.files || []);
  event.target.value = "";
});

$("#message-form").addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files || [])];
  if (files.length) { event.preventDefault(); addAttachments(files); }
});

for (const type of ["dragenter", "dragover"]) {
  $("#message-form").addEventListener(type, (event) => { event.preventDefault(); event.currentTarget.classList.add("dragging"); });
}
for (const type of ["dragleave", "drop"]) {
  $("#message-form").addEventListener(type, (event) => {
    event.preventDefault(); event.currentTarget.classList.remove("dragging");
    if (type === "drop") addAttachments(event.dataTransfer?.files || []);
  });
}

$("#accept-task").addEventListener("click", async () => {
  if (!confirm("Accept this task without full agent consensus?\n\nThis overrides the normal independent-review requirement. The task will be marked as human-accepted.")) return;
  const summary = prompt("Optional: add a short acceptance note (or press OK to skip).");
  try { await api(`/api/tasks/${selectedTaskId}/accept`, { method: "POST", body: JSON.stringify({ summary: summary || "Human accepted from dashboard" }) }); await refresh(); toast("Task accepted"); } catch (error) { toast(error.message); }
});

// Both the banner button and the old team-panel link open the same dialog. A plain prompt() could
// not offer the target list, and routing the replan to one agent by name is the whole reason the
// dialog exists: dropping it back into the open queue is how the work reached the wrong agent.
function openResumeDialog() {
  const task = state.selectedTask;
  const copy = task ? blockedBannerCopy(task.blockedRecovery) : null;
  if (!copy) { toast("This task is not blocked"); return; }
  $("#resume-context").textContent = `"${task.title}" was blocked: ${copy.reason}`;
  $("#resume-target").innerHTML = `<option value="">Whoever is available</option>`
    + copy.targets.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
  $("#resume-dialog").showModal();
}

$("#unblock-task").addEventListener("click", openResumeDialog);
$("#resume-task").addEventListener("click", openResumeDialog);

// The other way out of a block. Resume is right for work that genuinely stopped; it is the wrong
// shape for a task an agent blocked to mean "finished", which then needed a whole replan cycle just
// to close. The server refuses this if work was still in flight, and says how much.
$("#close-blocked-task").addEventListener("click", async () => {
  const summary = prompt("Close this task as finished. What was delivered?");
  if (summary === null) return;
  const body = { summary: summary.trim() || "Human closed a stopped task as finished." };
  try {
    await api(`/api/tasks/${selectedTaskId}/accept`, { method: "POST", body: JSON.stringify(body) });
  } catch (error) {
    // The only refusal worth a second question is "work was still in flight"; anything else stands.
    if (!/still in flight/.test(error.message)) { toast(error.message); return; }
    if (!confirm(`${error.message}

Close it anyway, leaving that work unfinished?`)) return;
    try {
      await api(`/api/tasks/${selectedTaskId}/accept`, {
        method: "POST", body: JSON.stringify({ ...body, acceptStranded: true }),
      });
    } catch (retryError) { toast(retryError.message); return; }
  }
  await refresh();
  toast("Task closed as finished");
});

$("#resume-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.target));
  try {
    const result = await api(`/api/tasks/${selectedTaskId}/unblock`, {
      method: "POST",
      body: JSON.stringify({ reason: values.reason, targetAgentName: values.targetAgentName || null }),
    });
    event.target.reset(); event.target.closest("dialog").close(); await refresh();
    toast(result.targetAgentName
      ? `Resumed at v${result.version} — replan addressed to ${result.targetAgentName}`
      : `Resumed at v${result.version} — the team can plan again`);
  } catch (error) { toast(error.message); }
});

$("#block-task").addEventListener("click", async () => {
  const reason = prompt("Why should the team stop this task?"); if (!reason) return;
  try { await api(`/api/tasks/${selectedTaskId}/block`, { method: "POST", body: JSON.stringify({ reason }) }); await refresh(); } catch (error) { toast(error.message); }
});

$("#copy-setup").addEventListener("click", async () => {
  try {
    const { mcpUrl, token } = await api("/api/setup");
    const setup = `DevTeam MCP\nURL: ${mcpUrl}\nAuthorization: Bearer ${token}\n\nCodex config.toml:\n[mcp_servers.devteam]\nurl = "${mcpUrl}"\nhttp_headers = { Authorization = "Bearer ${token}" }\ntool_timeout_sec = 60\n\nClaude JSON:\n{"mcpServers":{"devteam":{"type":"http","url":"${mcpUrl}","headers":{"Authorization":"Bearer ${token}"}}}}`;
    await navigator.clipboard.writeText(setup); toast("Desktop MCP setup copied");
  } catch (error) { toast(error.message); }
});

$("#copy-task-invite").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(agentInvite()); toast("Task-specific agent invite copied"); }
  catch { toast(agentInvite()); }
});

$("#jump-latest").addEventListener("click", () => {
  if (!state?.selectedTask) return;
  renderTimeline(state.selectedTask, { wasNearBottom: true });
});

let timelineScrollFrame = 0;
$("#event-list").addEventListener("scroll", () => {
  cancelAnimationFrame(timelineScrollFrame);
  timelineScrollFrame = requestAnimationFrame(() => {
    const list = $("#event-list");
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
    if (nearBottom) markTimelineRead();
    else $("#jump-latest").classList.remove("hidden");
  });
});

function searchResultMarkup(result) {
  const occurred = result.occurred_at ? relativeTime(result.occurred_at) : "";
  return `<button class="search-result" type="button" data-search-task="${escapeHtml(result.task_id || "")}" data-search-project="${escapeHtml(result.project_id || "")}" data-search-event="${Number(result.event_id) || ""}"><span class="search-kind">${escapeHtml(result.kind)}</span><span class="search-copy"><strong>${escapeHtml(result.title)}</strong><span>${escapeHtml(result.snippet || "No preview")}</span><small>${escapeHtml(result.project_name)} · ${escapeHtml(result.subtype || result.kind)}</small></span><time>${escapeHtml(occurred)}</time></button>`;
}

async function performWorkspaceSearch() {
  const input = $("#workspace-search");
  const results = $("#search-results");
  const query = input.value.trim();
  const generation = ++searchGeneration;
  if (query.length < 2) {
    results.innerHTML = `<p class="search-empty">Type at least two characters to search the workspace.</p>`;
    return;
  }
  results.innerHTML = `<p class="search-empty">Searching…</p>`;
  const project = $("#search-current-project").checked ? selectedProjectId : null;
  try {
    const params = new URLSearchParams({ q: query, limit: "50" });
    if (project) params.set("projectId", project);
    const response = await api(`/api/search?${params}`);
    if (generation !== searchGeneration) return;
    results.innerHTML = response.results.length
      ? response.results.map(searchResultMarkup).join("")
      : `<p class="search-empty">No workspace results for “${escapeHtml(query)}”.</p>`;
  } catch (error) {
    if (generation === searchGeneration) results.innerHTML = `<p class="search-empty">Search failed: ${escapeHtml(error.message)}</p>`;
  }
}

let searchTimer = 0;
$("#workspace-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(performWorkspaceSearch, 180);
});
$("#search-current-project").addEventListener("change", performWorkspaceSearch);
$("#open-search").addEventListener("click", () => setTimeout(() => $("#workspace-search").focus(), 0));
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (!$("#search-dialog").open) $("#search-dialog").showModal();
    $("#workspace-search").focus();
  }
});

function initPanelResizers() {
  const shell = $(".app-shell");
  const widths = {
    sidebar: Math.max(190, Math.min(420, Number(storageGet("dt-sidebar-width")) || 260)),
    team: Math.max(240, Math.min(520, Number(storageGet("dt-panel-width")) || 300)),
  };
  const applyWidth = (panel, width) => {
    const minimum = panel === "sidebar" ? 190 : 240;
    const hardMaximum = panel === "sidebar" ? 420 : 520;
    const peerWidth = widths[panel === "sidebar" ? "team" : "sidebar"];
    const layoutMaximum = window.innerWidth > 1050 ? Math.max(minimum, window.innerWidth - peerWidth - 460) : hardMaximum;
    widths[panel] = Math.round(Math.max(minimum, Math.min(hardMaximum, layoutMaximum, width)));
    shell.style.setProperty(panel === "sidebar" ? "--sidebar-open-w" : "--panel-open-w", `${widths[panel]}px`);
    storageSet(panel === "sidebar" ? "dt-sidebar-width" : "dt-panel-width", String(widths[panel]));
  };
  applyWidth("sidebar", widths.sidebar);
  applyWidth("team", widths.team);
  window.addEventListener("resize", () => {
    applyWidth("sidebar", widths.sidebar);
    applyWidth("team", widths.team);
  });
  for (const handle of document.querySelectorAll("[data-resize-panel]")) {
    const panel = handle.dataset.resizePanel;
    handle.setAttribute("aria-valuemin", panel === "sidebar" ? "190" : "240");
    handle.setAttribute("aria-valuemax", panel === "sidebar" ? "420" : "520");
    const syncValue = () => handle.setAttribute("aria-valuenow", String(widths[panel]));
    syncValue();
    handle.addEventListener("pointerdown", (event) => {
      if (window.innerWidth <= 1050) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add("resizing-panel");
    });
    handle.addEventListener("pointermove", (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const raw = panel === "sidebar" ? event.clientX : window.innerWidth - event.clientX;
      applyWidth(panel, Math.max(panel === "sidebar" ? 190 : 240, Math.min(panel === "sidebar" ? 420 : 520, raw)));
      syncValue();
    });
    const stop = (event) => {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      document.body.classList.remove("resizing-panel");
    };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
    handle.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const delta = panel === "sidebar" ? direction * 12 : direction * -12;
      applyWidth(panel, Math.max(panel === "sidebar" ? 190 : 240, Math.min(panel === "sidebar" ? 420 : 520, widths[panel] + delta)));
      syncValue();
    });
  }
}

function initPanelToggles() {
  const shell = $(".app-shell");
  const sidebarBtn = $("#toggle-sidebar");
  const teamBtn = $("#toggle-team");
  const narrow = window.innerWidth <= 1050;
  if (narrow) {
    shell.classList.add("sidebar-collapsed", "panel-collapsed");
  } else {
    if (storageGet("dt-sidebar") === "collapsed") shell.classList.add("sidebar-collapsed");
    if (storageGet("dt-panel") === "collapsed") shell.classList.add("panel-collapsed");
  }
  const sync = (persist = true) => {
    const sidebarOpen = !shell.classList.contains("sidebar-collapsed");
    const panelOpen = !shell.classList.contains("panel-collapsed");
    sidebarBtn.setAttribute("aria-expanded", String(sidebarOpen));
    teamBtn.setAttribute("aria-expanded", String(panelOpen));
    if (persist) {
      storageSet("dt-sidebar", sidebarOpen ? "open" : "collapsed");
      storageSet("dt-panel", panelOpen ? "open" : "collapsed");
    }
  };
  const togglePanel = (panel) => {
    const className = panel === "sidebar" ? "sidebar-collapsed" : "panel-collapsed";
    const opening = shell.classList.contains(className);
    shell.classList.toggle(className);
    if (opening && window.matchMedia("(max-width: 1050px)").matches) {
      shell.classList.add(panel === "sidebar" ? "panel-collapsed" : "sidebar-collapsed");
    }
    sync();
  };
  sidebarBtn.addEventListener("click", () => togglePanel("sidebar"));
  teamBtn.addEventListener("click", () => togglePanel("team"));
  for (const button of document.querySelectorAll("[data-close-panel]")) {
    button.addEventListener("click", () => {
      shell.classList.add(button.dataset.closePanel === "sidebar" ? "sidebar-collapsed" : "panel-collapsed");
      sync();
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !window.matchMedia("(max-width: 1050px)").matches) return;
    shell.classList.add("sidebar-collapsed", "panel-collapsed");
    sync();
  });
  sync(false);
}

// The page is long-lived; the server and its files are not. When the dashboard files change under a
// running page — an update, or a restart onto new code — say so, rather than leaving the owner
// looking at yesterday's markup and wondering why a fix did not land.
async function checkForDashboardUpdate() {
  try {
    const latest = await api("/api/config");
    if (config?.dashboardBuild && latest.dashboardBuild && latest.dashboardBuild !== config.dashboardBuild) {
      $("#update-banner").classList.remove("hidden");
    }
  } catch { /* the server is restarting; the next check will see it */ }
}
$("#reload-dashboard").addEventListener("click", () => window.location.reload());

async function boot() {
  initPanelToggles();
  initPanelResizers();
  try {
    config = await api("/api/config"); $("#server-address").textContent = new URL(config.mcpUrl).host;
    await refresh();
    const stream = new EventSource("/api/stream"); stream.onmessage = () => refresh().catch(() => {});
    // A reconnect is exactly when the server may have been restarted onto new files.
    stream.onopen = () => checkForDashboardUpdate();
    setInterval(checkForDashboardUpdate, 60_000);
    // Keep presence ("3s ago", pulse colour) live between server events.
    setInterval(() => { if (state) renderAgentList(); }, 5000);
  } catch (error) { toast(error.message); }
}
boot();

// Collapsing a nav section. The state is remembered per browser, and a collapsed section keeps
// showing the selected project or task above the fold — see #project-current / #task-current.
function applyNavCollapse(section, collapsed) {
  const nav = document.querySelector(".sidebar nav");
  if (!nav) return;
  nav.classList.toggle(`${section}-collapsed`, collapsed);
  const toggle = document.querySelector(`[data-collapse="${section}"]`);
  if (toggle) {
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    toggle.title = collapsed
      ? `Expand ${section === "projects" ? "projects" : "task history"}`
      : `Collapse ${section === "projects" ? "projects" : "task history"}`;
  }
  // A private convenience, so it is fine for this to be unavailable or to throw.
  try { localStorage.setItem(`devteam.nav.${section}`, collapsed ? "collapsed" : "open"); } catch { /* ignore */ }
}

for (const section of ["projects", "tasks"]) {
  let collapsed = false;
  try { collapsed = localStorage.getItem(`devteam.nav.${section}`) === "collapsed"; } catch { collapsed = false; }
  applyNavCollapse(section, collapsed);
}

document.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-collapse]");
  if (!toggle) return;
  const section = toggle.dataset.collapse;
  applyNavCollapse(section, toggle.getAttribute("aria-expanded") === "true");
});

// The board has two sizes, because a human only ever wants one of two things from it: what is
// happening right now, or the whole shape of the work. The strip answers the first in one line;
// expanding gives the graph the page. Both are the same #assignment-board element and the same
// render path — only the box around it changes.
let boardExpanded = false;
// Two views of the same board: Work is the dependency graph of what the team is doing, Map is the
// project those notes land in. The toggle only exists when the board is open, because the closed
// strip is one line about right now and a map has nothing to say in one line.
let boardView = "work";

function applyBoardView(view, { expand = true } = {}) {
  boardView = view === "map" ? "map" : "work";
  for (const button of document.querySelectorAll("[data-board-view]")) {
    button.setAttribute("aria-pressed", String(button.dataset.boardView === boardView));
  }
  resetZoom();
  $("#assignment-board").classList.toggle("hidden", boardView === "map");
  $("#code-map").classList.toggle("hidden", boardView !== "map");
  if (boardView === "map") {
    $("#assignment-detail").classList.add("hidden");
    if (expand && !boardExpanded) applyBoardMode(true);
    // Reading the map means having the map: fetch on arrival, and re-render once it lands.
    if (renderedTaskId) loadCodeMap(renderedTaskId);
    renderCodeMap();
  }
  try { localStorage.setItem("devteam.boardView", boardView); } catch { /* ignore */ }
}

function applyBoardMode(expanded) {
  boardExpanded = Boolean(expanded);
  const expand = $("#expand-board");
  $("#work-board").classList.toggle("is-full", boardExpanded);
  document.querySelector(".workspace").classList.toggle("board-full", boardExpanded);
  expand.setAttribute("aria-pressed", String(boardExpanded));
  expand.setAttribute("aria-expanded", String(boardExpanded));
  expand.title = boardExpanded ? "Back to the current work" : "Open the whole board";
  expand.textContent = boardExpanded ? "⤡" : "⤢";
  // Collapsing keeps the strip's job: what is happening now, which is the work board's answer.
  if (!boardExpanded && boardView === "map") applyBoardView("work", { expand: false });
  if (boardExpanded && boardView === "map") renderCodeMap();
  // A private convenience, so it is fine for this to be unavailable or to throw.
  try { localStorage.setItem("devteam.board", boardExpanded ? "full" : "strip"); } catch { /* ignore */ }
}

try { applyBoardMode(localStorage.getItem("devteam.board") === "full"); } catch { applyBoardMode(false); }
try { applyBoardView(boardExpanded && localStorage.getItem("devteam.boardView") === "map" ? "map" : "work", { expand: false }); } catch { applyBoardView("work", { expand: false }); }

$("#expand-board").addEventListener("click", () => applyBoardMode(!boardExpanded));
$("#board-views").addEventListener("click", (event) => {
  const button = event.target.closest("[data-board-view]");
  if (button) applyBoardView(button.dataset.boardView);
});

// Escape is the way out of anything full-screen. Dialogs handle their own, so only take it when
// one is not open and the person is not typing. On the map, the first Escape drops the file you
// were reading rather than throwing away the whole view.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !boardExpanded) return;
  if (document.querySelector("dialog[open]")) return;
  if (event.target.closest("input, textarea, select")) return;
  if (boardView === "map" && (mapSelected || mapGroupFilter)) {
    mapSelected = null;
    mapGroupFilter = null;
    paintCodeMap();
    return;
  }
  applyBoardMode(false);
});
