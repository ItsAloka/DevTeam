// Domain checklists, read from Markdown the owner writes by hand.
//
// These files are the owner's, not DevTeam's. DevTeam never writes into `checklists/` — it parses
// the files and puts the relevant lines in front of the roles that verify work. An earlier version
// generated these files from reviewers' findings and read the owner's edits back; that inverted the
// useful direction. A checklist is knowledge the owner already has (from shipping something, from a
// post-mortem, from a list worth keeping) and wants applied to every future review. Growing one from
// whatever a reviewer happened to complain about produced lists nobody trusted.
//
// One file per domain: `<checklist dir>/<domain>.md`, where the domain names come from domains.mjs.
// A file may declare in frontmatter which roles it feeds, so `security.md` can reach the security
// reviewer on every task without being duplicated into each domain's file.
//
// Format (see checklists/README.md, which is the owner-facing copy of this):
//
//   ---
//   domain: web
//   applies_to: [reviewer, security-reviewer]
//   ---
//   ## Security & auth
//   - [ ] (*) input validation on every value from user/url/header/external api
//   - [ ] injection blocked -> parameterised queries only
//   - [-] MFA (not applicable to this project)
//
// `(*)` marks an item critical: those are the only lines inlined into a brief. `[-]` marks a line
// the owner has ruled out; it is parsed so the file round-trips, and then ignored. Everything else
// is a line the reviewer is told to walk in the file itself — a 150-item list cannot fit in a brief,
// and reviewers can read files.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const CHECKLIST_RULE_MAX = 220;
export const DEFAULT_CHECKLIST_DIRNAME = "checklists";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u;
const HEADING = /^#{2,3}\s+(.+?)\s*$/u;
const BULLET = /^\s*[-*]\s*\[( |x|X|-)\]\s*(.+?)\s*$/u;
const CRITICAL = /^\(\*\)\s*/u;

export const checklistPath = (dir, domain) => path.join(dir, `${domain}.md`);

// Parse one checklist file's text. Unknown frontmatter keys are kept but unused, so the owner can
// annotate a file without DevTeam rejecting it.
export function parseChecklist(text, domain = null) {
  const raw = String(text ?? "");
  const front = raw.match(FRONTMATTER);
  const meta = {};
  if (front) {
    for (const line of front[1].split(/\r?\n/u)) {
      const pair = line.match(/^\s*([a-z_][a-z0-9_]*)\s*:\s*(.*?)\s*$/iu);
      if (!pair) continue;
      const bare = pair[2].replace(/^\[(.*)\]$/u, "$1");
      const unquote = (value) => value.trim().replace(/^["']|["']$/gu, "");
      meta[pair[1].toLowerCase()] = /^\[/u.test(pair[2]) || bare.includes(",")
        ? bare.split(",").map(unquote).filter(Boolean)
        : unquote(bare);
    }
  }
  const body = front ? raw.slice(front[0].length) : raw;
  const sections = [];
  let section = null;
  const push = (title) => { section = { title, items: [] }; sections.push(section); };
  for (const line of body.split(/\r?\n/u)) {
    const heading = line.match(HEADING);
    if (heading) { push(heading[1].replace(/[-\s]+$/u, "").trim().slice(0, 80) || "General"); continue; }
    const bullet = line.match(BULLET);
    if (!bullet) continue;
    if (!section) push("General");
    section.items.push({
      text: bullet[2].replace(CRITICAL, "").trim().slice(0, CHECKLIST_RULE_MAX),
      critical: CRITICAL.test(bullet[2]),
      skipped: bullet[1] === "-",
      done: bullet[1] === "x" || bullet[1] === "X",
    });
  }
  const live = sections.flatMap((entry) => entry.items.filter((item) => !item.skipped));
  const appliesTo = (Array.isArray(meta.applies_to) ? meta.applies_to : meta.applies_to ? [meta.applies_to] : [])
    .map((role) => String(role).trim().toLowerCase()).filter(Boolean);
  return {
    domain: (typeof meta.domain === "string" && meta.domain) || domain,
    title: (typeof meta.title === "string" && meta.title) || null,
    appliesTo,
    sections: sections.filter((entry) => entry.items.length),
    itemCount: live.length,
    criticalCount: live.filter((item) => item.critical).length,
  };
}

// mtime+size keyed, so editing a checklist takes effect on the next brief without a restart, and an
// untouched file is parsed once no matter how many assignments ask for it.
const cache = new Map();

export function loadChecklist(dir, domain) {
  const file = checklistPath(dir, domain);
  let stamp;
  try {
    const stat = statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    cache.delete(file);
    return null;
  }
  const hit = cache.get(file);
  if (hit?.stamp === stamp) return hit.value;
  let value = null;
  try {
    value = { ...parseChecklist(readFileSync(file, "utf8"), domain), file };
  } catch {
    value = null;
  }
  cache.set(file, { stamp, value });
  return value;
}

export const clearChecklistCache = () => cache.clear();

// Which checklists a role in these domains should be handed. A file with no `applies_to` feeds every
// role that asks; one that names roles feeds only those. `always` are files pulled in regardless of
// the task's domains (security.md is the motivating case) — they still honour `applies_to`.
export function resolveChecklists(dir, domains, role, { always = [] } = {}) {
  if (!dir) return [];
  const wanted = [...new Set([...(domains || []), ...always])];
  const name = String(role || "").trim().toLowerCase();
  const out = [];
  for (const domain of wanted) {
    const loaded = loadChecklist(dir, domain);
    if (!loaded || !loaded.itemCount) continue;
    if (loaded.appliesTo.length && name && !loaded.appliesTo.includes(name)) continue;
    out.push(loaded);
  }
  return out;
}

// What an assignment's brief carries: the file paths to open, and the critical lines inlined so a
// reviewer who ignores the files still sees the ones that cause a breach, a bill or an outage.
// Deduplicated by text, because one rule listed in two domains is one line to read.
export function checklistBrief(dir, domains, role, { always = [], maxItems = 15, maxBytes = 3_584 } = {}) {
  const files = resolveChecklists(dir, domains, role, { always });
  if (!files.length) return null;
  const seen = new Set();
  const perFile = files.map((file) => {
    const out = [];
    for (const section of file.sections) {
      for (const item of section.items) {
        if (!item.critical || item.skipped) continue;
        const key = item.text.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ domain: file.domain, section: section.title, rule: item.text });
      }
    }
    return out;
  });
  // Round-robin across files rather than draining one at a time. A domain with many critical lines
  // would otherwise fill the whole budget and push security.md out of the brief entirely.
  const ranked = [];
  for (let index = 0; perFile.some((list) => index < list.length); index += 1) {
    for (const list of perFile) if (index < list.length) ranked.push(list[index]);
  }
  const critical = [];
  for (const item of ranked) {
    if (critical.length >= maxItems) break;
    if (Buffer.byteLength(JSON.stringify([...critical, item]), "utf8") > maxBytes) break;
    critical.push(item);
  }
  return {
    files: files.map((file) => ({
      domain: file.domain,
      path: file.file,
      sections: file.sections.map((section) => section.title),
      items: file.itemCount,
    })),
    critical,
    omitted: ranked.length - critical.length,
    totalItems: files.reduce((sum, file) => sum + file.itemCount, 0),
  };
}

// Domains that actually have a checklist on disk. The task-creation picker offers only these: a
// domain with no file buys nothing, and offering it suggests a check that will never happen.
export function availableDomains(dir, domains) {
  if (!dir || !existsSync(dir)) return [];
  return (domains || []).filter((domain) => (loadChecklist(dir, domain)?.itemCount ?? 0) > 0);
}
