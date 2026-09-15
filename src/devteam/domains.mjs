// The domain vocabulary checklists are grown under. A small set of common IT domains is built in;
// the owner can add more. The list is still curated rather than free-form: a near-synonym ("frontend"
// beside "web") would split one team's lessons across two lists and starve both, so obvious aliases
// are refused and names must be plain slugs (they also become checklist file names).
export const DEFAULT_DOMAINS = Object.freeze([
  "web", "backend", "mobile", "desktop", "game", "ml", "data", "devops", "docs", "embedded", "security",
]);

export const DOMAIN_NAME_PATTERN = /^[a-z][a-z0-9-]{1,29}$/u;

// Words that already mean a built-in domain. Adding one is refused with a pointer to the real name.
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

// Check a proposed new domain name. Returns the cleaned name or throws a message a human can act on.
export function validateNewDomainName(raw, existing) {
  const name = String(raw ?? "").trim().toLowerCase().replace(/[\s_]+/gu, "-");
  if (!DOMAIN_NAME_PATTERN.test(name)) {
    throw new Error("A domain name is 2–30 characters: lowercase letters, digits and hyphens, starting with a letter.");
  }
  if (existing.includes(name)) throw new Error(`The domain "${name}" already exists.`);
  const alias = DOMAIN_ALIASES[name];
  if (alias && existing.includes(alias)) throw new Error(`"${name}" is already covered by the "${alias}" domain; use that instead.`);
  return name;
}

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
