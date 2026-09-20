// Three roles, one direction: plan → implement → review.
//
// Roles used to be a per-project vocabulary. A project declared its own in `.devteam/roles.json`,
// mapped each name onto two scheduling behaviours, and agents could propose and vote on who held
// which one. Six defaults shipped — planner, implementer, researcher, reviewer, security-reviewer,
// tester — and the file existed so a legal or editorial project could call them something else.
//
// Nobody wanted that. Every piece of work in every domain goes through the same three hands, and the
// domain only ever changed *what a reviewer checks* — which is what the checklist directory is for
// (checklists/<domain>.md, chosen per task). So: research folds into planning, testing folds into
// implementing (you run what you built), and security review is a review with the security checklist
// attached.
//
// The two scheduling behaviours survive, because they are what the scheduler actually reads:
//
//   * `verifies`: this role reads the work rather than changing it, so it waits for pending writers,
//     its completion is what earns the right to approve or to request changes, and its presence
//     alone means the task is in review.
//   * `plans`: this role decides what the team does next, so an open one means the task is still
//     being planned, and it is what DevTeam seeds a new or resumed task with.
//
// They are now implied by the role name rather than configured, but they stay as columns on the
// assignment: the scheduler keys off them in SQL, and a row records the behaviour it was created
// with rather than re-deriving it from a name later.

export const PLANNING_ROLE = "planner";
export const REVIEW_ROLE = "reviewer";
export const IMPLEMENTATION_ROLE = "implementer";

export const ROLES = Object.freeze({
  [PLANNING_ROLE]: {
    plans: true,
    writes: false,
    verifies: false,
    description: "Decides what the team does next, researching whatever it needs to decide, and creates the assignments.",
    checklist: [],
  },
  [IMPLEMENTATION_ROLE]: {
    plans: false,
    writes: true,
    verifies: false,
    description: "Produces the work product and exercises it before reporting.",
    checklist: [],
  },
  [REVIEW_ROLE]: {
    plans: false,
    writes: false,
    verifies: true,
    description: "Reads someone else's finished work and judges whether it is correct.",
    checklist: [
      "Correctness: does it do what the task asked?",
      "Edge cases and boundary conditions handled",
      "Error and failure paths are handled, not swallowed",
      "No dead code, debug logs, or leftover TODOs",
      "Readable and consistent with the surrounding code",
      "Tests cover the change and actually run",
      "Walk the checklistFiles in your brief — the sections your change touches — and name them in your report",
    ],
  },
});

export const ROLE_NAMES = Object.freeze(Object.keys(ROLES));

// Every name this has ever answered to, mapped onto the three that remain. Used for the one-time
// migration of existing rows and to keep a planner that types an old name from creating work in a
// role the scheduler no longer knows.
const ALIASES = Object.freeze({
  researcher: PLANNING_ROLE, planning: PLANNING_ROLE, plan: PLANNING_ROLE, architect: PLANNING_ROLE,
  implement: IMPLEMENTATION_ROLE, implementor: IMPLEMENTATION_ROLE, builder: IMPLEMENTATION_ROLE,
  developer: IMPLEMENTATION_ROLE, tester: IMPLEMENTATION_ROLE, qa: IMPLEMENTATION_ROLE,
  review: REVIEW_ROLE, "security-reviewer": REVIEW_ROLE, security: REVIEW_ROLE,
  "code-reviewer": REVIEW_ROLE, critic: REVIEW_ROLE,
});

// Resolve whatever was asked for onto one of the three. An unrecognised name is implementation work:
// that is the role with no special scheduling power, so a typo can never accidentally produce a
// reviewer whose completion earns an approval, or a planner that holds the task open.
export function normalizeRoleName(name) {
  const clean = String(name ?? "").trim().toLowerCase();
  if (!clean) return IMPLEMENTATION_ROLE;
  if (ROLES[clean]) return clean;
  return ALIASES[clean] || IMPLEMENTATION_ROLE;
}

// The behaviour of a role, and the checklist its assignments carry.
export function roleBehaviour(name) {
  const key = normalizeRoleName(name);
  const definition = ROLES[key];
  return {
    name: key,
    known: true,
    verifies: definition.verifies,
    plans: definition.plans,
    writes: definition.writes,
    checklist: definition.checklist,
  };
}

// What the dashboard's assignment form and a joining agent are told this room understands.
export function roleCatalogue() {
  return { roles: ROLE_NAMES.map((name) => ({ name, ...ROLES[name] })) };
}
