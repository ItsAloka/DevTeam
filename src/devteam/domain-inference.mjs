// Domain hints are deliberately conservative. They are advice for a planner, never a substitute
// for the explicit `domains` requested when a task is created — a wrong domain delivers the wrong
// checklist, which is worse than delivering none.
//
// So every marker must be specific to its domain. Generic folder names (`models/`, `server/`,
// `data/` alone) and loose file types (any `.swift`, any `.csv`) are not evidence: an MVC backend
// has models, a SwiftPM server has Swift, and every test suite has fixture CSVs.
import { DOMAINS } from "./store.mjs";

// Kept as the historical export name; it is the canonical enum, not a second copy of it.
export const DOMAIN_ORDER = DOMAINS;

// How many example paths are returned per domain. The count of all matches is returned alongside,
// so the result stays small enough for a brief however large the project is.
export const EVIDENCE_PER_DOMAIN = 5;

// Paths under these directories describe tests, samples or vendored code, not what the project is.
const IGNORED = /(^|\/)(test|tests|__tests__|spec|specs|fixtures?|examples?|samples?|node_modules|vendor|third_party)\//u;

const MARKERS = Object.freeze([
  ["mobile", (file) => /(^|\/)(pubspec\.yaml|androidmanifest\.xml|info\.plist|podfile)$/u.test(file)
    || /(^|\/)[^/]+\.xcodeproj\//u.test(file)
    || /^(android|ios)\/.+/u.test(file)],
  ["ml", (file) => /\.(ipynb|pt|pth|onnx|h5|safetensors|ckpt)$/u.test(file)],
  ["data", (file) => /(^|\/)dbt_project\.yml$/u.test(file)
    || /\.(parquet|feather|avro)$/u.test(file)
    || /(^|\/)(migrations|warehouse|etl|pipelines)\/.+\.sql$/u.test(file)],
  ["devops", (file) => /(^|\/)(dockerfile|docker-compose(\.[^/]+)?\.ya?ml|terraform\.tf|main\.tf)$/u.test(file)
    || /^\.github\/workflows\/.+\.ya?ml$/u.test(file)
    || /(^|\/)(k8s|helm|charts)\/.+\.ya?ml$/u.test(file)],
  ["docs", (file) => /^docs\/.+\.(md|mdx|rst)$/u.test(file) || /(^|\/)(mkdocs\.yml|docusaurus\.config\.[jt]s)$/u.test(file)],
  ["web", (file) => /(^|\/)(next|vite|nuxt|astro|svelte)\.config\.[cm]?[jt]s$/u.test(file)
    || /(^|\/)(angular\.json)$/u.test(file)
    || /^(public|static)\/index\.html$/u.test(file)
    || /^index\.html$/u.test(file)],
  ["backend", (file) => /^(src\/)?(api|routes|controllers|handlers)\/.+\.(m?[jt]s|py|go|rb|java|kt|cs|php)$/u.test(file)
    || /(^|\/)(manage\.py|wsgi\.py|asgi\.py)$/u.test(file)],
]);

/**
 * Suggest domains from already-visible project file names.
 *
 * A result with no domains is intentionally useful: it means the planner should declare domains
 * explicitly. Likewise, a project that matches more than three domains is too mixed to guess.
 * Evidence keeps each path's original spelling and is capped per domain, with the full count.
 */
export function suggestDomains(paths = []) {
  const evidence = new Map();
  for (const raw of Array.isArray(paths) ? paths : []) {
    const original = String(raw ?? "").trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
    if (!original) continue;
    const file = original.toLowerCase();
    if (IGNORED.test(file)) continue;
    for (const [domain, matches] of MARKERS) {
      if (!matches(file)) continue;
      if (!evidence.has(domain)) evidence.set(domain, { paths: [], seen: new Set() });
      const entry = evidence.get(domain);
      if (entry.seen.has(file)) continue;
      entry.seen.add(file);
      if (entry.paths.length < EVIDENCE_PER_DOMAIN) entry.paths.push(original);
    }
  }

  const domains = DOMAIN_ORDER.filter((domain) => evidence.has(domain));
  if (!domains.length) return { domains: [], evidence: {}, note: "No clear domain marker; declare domains explicitly." };
  if (domains.length > 3) return {
    domains: [], evidence: {},
    note: "More than three domains matched; declare domains explicitly rather than guessing.",
  };
  return {
    domains,
    evidence: Object.fromEntries(domains.map((domain) => {
      const entry = evidence.get(domain);
      return [domain, { paths: entry.paths, total: entry.seen.size }];
    })),
    note: null,
  };
}
