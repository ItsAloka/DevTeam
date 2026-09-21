# Improvements for later

Ideas and known gaps worth doing someday. Not urgent; pick one up when it bites.

## Work board: a card-timing guess could misfire (watch for it)

**Done 2026-09-21.** `layoutAssignmentBoard` (`public/ui-utils.js`) now puts a card with no
dependency beside the other undeclared cards created within 90 seconds of it, as one parallel row.
Reviews sit under the work they check, and planner cards always start a new row.

**What could still look wrong.** If a planner creates a real sequence within 90 seconds and doesn't
declare it, the board draws it side by side. The scheduler would also run those jobs at the same time,
so the drawing matches what really happens, but it may not match what the planner meant. If this
shows up, shorten the window (`parallelWindowMs`) or ask planners to declare the order (the skill
already does).

## Stale memory text in the MCP tool description

The `devteam_memory` tool description in `src/devteam/mcp.mjs` (around line 276) still says DevTeam
builds the vault by itself and mentions `devteam_propose`, which no longer exists. Every agent reads
it on every session, and it contradicts the skill: notes are only saved through `learned` on a report
or `devteam_memory action=write`. The same file also repeats a four-line comment above
`devteam_join` (around lines 61-68).
