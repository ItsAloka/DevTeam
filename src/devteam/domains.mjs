// Markers that domain inference recognizes, and the names of the example checklists DevTeam ships.
// They do not make a domain selectable: the checklist directory is the live vocabulary.
export const DEFAULT_DOMAINS = Object.freeze([
  "web", "backend", "mobile", "desktop", "game", "ml", "data", "devops", "docs", "embedded", "security",
]);

export const DOMAIN_NAME_PATTERN = /^[a-z][a-z0-9-]{1,29}$/u;

// Alternate names for the canonical checklist domains. They prevent duplicate files from splitting
// one team's guidance when the canonical file is present.
export const DOMAIN_ALIASES = Object.freeze({
  frontend: "web", "front-end": "web", website: "web", webapp: "web", ui: "web",
  server: "backend", "back-end": "backend", api: "backend", apis: "backend",
  android: "mobile", ios: "mobile", app: "mobile", apps: "mobile",
  gaming: "game", games: "game", gamedev: "game",
  ai: "ml", "machine-learning": "ml", llm: "ml", "deep-learning": "ml",
  database: "data", databases: "data", analytics: "data", etl: "data", "data-engineering": "data",
  infra: "devops", infrastructure: "devops", ops: "devops", cicd: "devops", "ci-cd": "devops", cloud: "devops", sre: "devops",
  documentation: "docs", doc: "docs",
  iot: "embedded", firmware: "embedded", hardware: "embedded",
  appsec: "security", infosec: "security", cybersecurity: "security", pentest: "security",
});

// Validate and normalise a domains list against the allowed names. undefined/null stays undefined so
// callers can tell "not given" (inherit or keep) from an explicit empty list. Output follows the
// allowed list's order, so the same set always serialises the same way.
export function normalizeDomains(value, allowed = DEFAULT_DOMAINS) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("domains must be an array.");
  const cleaned = [...new Set(value.map((domain) => String(domain).trim().toLowerCase()).filter(Boolean))];
  const unknown = cleaned.filter((domain) => !allowed.includes(domain));
  if (unknown.length) throw new Error(`Unknown domain(s): ${unknown.join(", ")}. Valid domains: ${allowed.join(", ")}.`);
  return allowed.filter((domain) => cleaned.includes(domain));
}
