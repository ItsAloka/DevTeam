// The helpers every part of the store reaches for. They lived at the top of store.mjs and had
// to move out when the clusters did: a mixin importing them back from store.mjs — which imports the
// mixin — would be a cycle, and a cycle that happens to work today is not a thing to build on.

export const now = () => new Date().toISOString();

export const json = (value) => JSON.stringify(value ?? null);

// A column that should hold JSON may hold anything at all: a value written before a shape changed,
// or one a human edited by hand. Answer the fallback rather than throwing, because none of these
// callers can do anything useful with a parse error except lose the row.
export const fromJson = (value, fallback = null) => {
  try {
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
};

// File paths reach the map and the vault from two places that were never validated against the code
// graph: a note's related files, and the changed files an agent reports. Both are written by hand,
// so they arrive with backslashes, leading `./`, backticks, and trailing asides like "(NEW)" or
// "(reviewed, not edited)". Repairing the obvious damage here is what lifts the match rate against
// indexed modules from 65% to 87% on this project's own history; anything still unmatched is
// dropped rather than guessed at, because a node in the wrong place is worse than a missing one.
export function normalizeMapPath(value = "") {
  return String(value ?? "")
    .trim()
    .replace(/^[`"']+|[`"']+$/g, "")
    .replace(/\s*\([^()]*\)\s*$/, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
}
