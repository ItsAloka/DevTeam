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
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DOMAIN_ALIASES, DOMAIN_NAME_PATTERN } from "./domains.mjs";

export const CHECKLIST_RULE_MAX = 220;
export const DEFAULT_CHECKLIST_DIRNAME = "checklists";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u;
const HEADING = /^(#{2,3})\s+(.+?)\s*$/u;
const BULLET = /^\s*[-*]\s*\[( |x|X|-)\]\s*(.+?)\s*$/u;
const CRITICAL = /^\(\*\)\s*/u;
// Files in the directory that document it rather than define a domain.
const RESERVED_FILENAMES = new Set(["readme", "index", "notes", "template"]);

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
  // `group` is the `##` heading a section sits under: its own title for a `##`, the enclosing one for
  // a `###`. Reviewers report sections by `##` name, so that is what a report is checked against.
  const sections = [];
  let section = null;
  let group = null;
  const push = (title, level) => {
    if (level === 2) group = title;
    section = { title, level, group, items: [] };
    sections.push(section);
  };
  for (const line of body.split(/\r?\n/u)) {
    const heading = line.match(HEADING);
    if (heading) { push(heading[2].replace(/[-\s]+$/u, "").trim().slice(0, 80) || "General", heading[1].length); continue; }
    const bullet = line.match(BULLET);
    if (!bullet) continue;
    if (!section) push("General", 2);
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
    // The filename defines the selectable domain. Frontmatter may describe a standalone parsed
    // document, but it must not make `web-backend.md` appear in briefs as a different domain.
    domain: domain || (typeof meta.domain === "string" && meta.domain) || null,
    title: (typeof meta.title === "string" && meta.title) || null,
    appliesTo,
    sections: sections.filter((entry) => entry.items.length),
    itemCount: live.length,
    criticalCount: live.filter((item) => item.critical).length,
  };
}

// Content-keyed, so editing a checklist takes effect on the next brief without a restart, and an
// untouched file is parsed once no matter how many assignments ask for it.
//
// This was keyed on mtime+size, which missed an edit that changed neither: two writes of the same
// byte length landing on one filesystem timestamp tick served the stale parse. Measured at 6 stale
// reads in 200 same-size edits. The edits that hit it are the likely ones — fixing a typo, swapping
// a word, or `- [ ]` -> `- [x]`, which is byte-identical and changes what the line means.
//
// So the file is read every time and the hash of its contents is the key. The read is a few KB; the
// parse is the expensive half and is still cached. Correctness here is worth more than a stat: a
// checklist the owner has just corrected must not brief the old text.
const cache = new Map();

export function loadChecklist(dir, domain) {
  const file = checklistPath(dir, domain);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    cache.delete(file);
    return null;
  }
  const stamp = createHash("sha1").update(text).digest("hex");
  const hit = cache.get(file);
  if (hit?.stamp === stamp) return hit.value;
  let value = null;
  try {
    value = { ...parseChecklist(text, domain), file };
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
    if (loaded.appliesTo.length && !loaded.appliesTo.includes(name)) continue;
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

// Domains that actually have a checklist on disk, out of the ones asked about.
export function availableDomains(dir, domains) {
  if (!dir || !existsSync(dir)) return [];
  return (domains || []).filter((domain) => (loadChecklist(dir, domain)?.itemCount ?? 0) > 0);
}

// Every domain the directory defines, from its file names. This is how a new domain comes into
// existence: you write `checklists/<name>.md`. There is no separate registration step, because a
// registered name with no file promises a check that cannot happen — which is what the old "add
// domain" button produced.
//
// `frontend.md` is skipped only when `web.md` is also present: two names for one domain split a
// team's lessons across two lists and starve both. With no web.md there is nothing to split, so the
// name is yours to use — someone who renames web.md to frontend.md means it as the domain's name.
// README.md is the directory's own documentation, and non-slug names are not domains either.
export function listChecklistDomains(dir) {
  if (!dir) return [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name.slice(0, -3).toLowerCase())
    .filter((name) => DOMAIN_NAME_PATTERN.test(name) && !RESERVED_FILENAMES.has(name))
    .sort();
  const present = new Set(names);
  return names.filter((name) => !(DOMAIN_ALIASES[name] && present.has(DOMAIN_ALIASES[name])));
}
