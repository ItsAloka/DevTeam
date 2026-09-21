---
name: devteam
description: Join or rejoin a local DevTeam MCP room to plan, implement, test, review, and reach consensus with Codex, Claude, or other AI agents. Use when the user says $devteam or /devteam, asks this agent to join, reconnect, or rejoin DevTeam, requests multi-agent collaboration, or wants agents to claim work from the local team portal.
---

# DevTeam

DevTeam is a shared whiteboard for a local team — AI agents and the human. The board holds the task,
its assignments and who holds them; the room holds the conversation; the vault holds what the project
has learned. You take one bounded assignment at a time, inspect the real project before you act,
report what you actually did, and check other people's work honestly.

**DevTeam coordinates work. It does not perform it.** It never edits files, never runs your build or
tests, and never touches git beyond reading `HEAD`. A report is your evidence, not a commit, push or
PR. Never tell the human you committed, pushed, merged or deployed unless you ran it this session and
saw it succeed, and never push, deploy, publish or delete data unless the human asked for it.

**Work in the project root** named in your brief (`project_root`), not in a separate worktree or copy.
Teammates and reviewers read the project root; work anywhere else is invisible to them.

The project files are the source of truth. DevTeam tells you what the team knows, not what the code says.

## The nine verbs

| | |
|---|---|
| `devteam_join` | arrive, enter a room, or resume a dropped session |
| `devteam_next` | wait for your next assignment or message; `want=state` / `want=brief` look things up |
| `devteam_plan` | put an assignment on the board |
| `devteam_report` | finish the assignment you hold, with evidence and anything you `learned` |
| `devteam_verdict` | approve, or send back, work you reviewed |
| `devteam_stuck` | ask why work will not move, or stop the task for the human |
| `devteam_memory` | search the vault, record a durable fact, or use the scratchpad |
| `devteam_message` | talk to the room or one teammate |
| `devteam_leave` | end the session |

## The loop

`join` → `next` → inspect and do the work → `report` → back to `next`. Every call can carry
`pendingMessages` and `steering`; read them before carrying on. Everything below is detail on the
parts that go wrong.

## Joining

Call `devteam_join` with `name`, `provider`, `capabilities`, and `taskId` for the room you mean to
work in. **Until you are in a room, nothing is claimable by you.** If the reply carries `roomRequired`,
pick from `availableTasks` — the one the human named, or the only open one in this project — and join
again with your `agentId` and that `taskId`. Pass `model` and `effort` as a human would name them
("Sonnet 5", "high") and only what you actually are; they are recorded so the board says who did what.
Join with `role=observer` only when asked to watch: an observer reads the room and never claims work.

Keep `agentId` and `resumeToken` private. If the connection drops, arrive again, then join with your
new `agentId` plus the old `resumeToken` to reclaim that session's claim, room and missed messages.

Work moves through three roles in one direction: **planner** → **implementer** → **reviewer**. A
planner decides what the team does next and researches whatever it needs to decide. An implementer
produces the work and exercises it. A reviewer reads someone else's finished work and judges it.
Security review is a reviewer assignment with the `security` domain selected, not a separate role.

**The human's word in the room outranks the scheduler.** If the human says who plans, implements or
reviews and the board hands you something else, do not do it anyway: re-address it with
`devteam_plan targetAgentName=…`, report your claim done saying you handed it on, and tell that
teammate with `devteam_message`.

## Getting work

`devteam_next` blocks until there is an assignment or a message. No model tokens are spent while it
blocks, so call it with the default timeout rather than polling. It answers with one of:

- `assigned` — the task, your `assignment` with its `claimToken` and write scope (`writeScope`), the
  checklist, any `domainChecklist` / `checklistFiles`, relevant vault notes, the files around the work
  (`codeContext`), recent events and open questions. **Read it, then inspect the actual files.** The
  brief is clipped to fit; `briefMeta.clipped` says what was cut.
- `message` — someone, often the human, is trying to reach you. Answer with `devteam_message` if a
  reply is expected, then call `next` again.
- `steering` — the human asked you to stop the assignment you hold. Stop as soon as it is safe and
  report what you have (`status=blocked` if incomplete). Do not abandon the claim.
- `room_required` — join a room first.
- `idle` — nothing for you yet. With `keepWaiting: true` the team is still busy; call `next` again.
  After about five quiet minutes, or when `keepWaiting` is false, leave and tell the human. If
  `blockedRooms` is present the task is stopped and only the human can restart it: say so and stop.
  Never recreate a blocked task elsewhere.

The lookups do not block. `want=state` (with `taskId`) returns the full task: every assignment and
its status, events with their ids, approvals, members, check baselines and regressions. Use it to see
what teammates did and to find an event id for `replyTo`. `want=brief` re-reads your briefing.
`want=module` with a `path` returns a file's importers and imports from the code graph, when
`codeContext` was not enough.

## Doing the assignment

Stay inside the assignment. The write scope is a real lease; writing outside it damages teammates'
work. If the work is bigger or different than described, say so in your report or as a message rather
than widening it. Other uncommitted changes in the tree may be a teammate's: leave them alone.

Finish with `devteam_report`, always passing `claimToken`:

- `changedFiles` — every file you changed, exactly. Changed files advance the task version and clear
  earlier approvals. A read-only assignment reports none.
- `checks` — DevTeam runs nothing, so a check is your word. Use `{ label, status: "passed" | "failed" }`
  for anything you ran, and name it the same way every time (`"npm test"`): DevTeam compares each
  label with what the task last recorded, and a check now failing that previously passed is raised as
  a regression, with a fix routed to whoever changed files since. Reporting `done` with a failing
  check is refused and your claim is kept so you can fix it. A bare string is recorded as an
  assertion and moves no baseline.
- `learned` — see Memory. Up to three durable facts.
- `checklistSections` — the `## ` sections of `checklistFiles` you actually walked.
- `message` — what you did and why, what you did not do, and anything the reviewer should look at.
- `status=blocked` closes only this assignment and queues planner triage; the task keeps running.

## Memory

**Nothing you learn is saved unless you save it.** DevTeam no longer mines events or reports for
facts; the vault's recap pages (`CURRENT.md`, one page per task) are generated, but the searchable
notes that reach future briefs come only from agents. There are two ways in:

- `learned` on `devteam_report` — the normal path. Whenever the work taught you something the next
  person would otherwise rediscover, add it: an API limit, why the obvious approach fails here, a
  convention the code keeps but never states, a trap in the build. Give it a `category`
  (architecture, decisions, components, conventions, pitfalls, workflows), a `title` that states the
  fact ("The billing API rate-limits at 30 requests/minute", not "Billing API") and a `body` someone
  can act on. It is tied to the files you changed. An empty list is honest when nothing was learned;
  a list of progress notes is not memory.
- `devteam_memory action=write` — for a fact you learn outside a report, for example while planning
  or reviewing. Add `relatedFiles` so it goes stale when they change, and an honest `confidence`
  (`low` is still worth recording; notes are ranked by it). Link related notes inline with
  `[[category/slug]]`.

Before starting non-trivial work, read the vault notes in your brief and use `action=search` (words,
a path, a component; narrow with `category`) when a headline looks relevant or the brief had none. `action=get` / `set` is a
small versioned scratchpad, `scope=task` or `scope=project`, for shared working state such as open
questions; pass `expectedVersion`, and on a conflict re-read and merge.

## Checklists

Reviewer assignments carry the role's base `checklist`. When the assignment has selected domains
whose file the owner has written, they also carry `domainChecklist` and `checklistFiles`. These are
checklists **the owner wrote by hand** at `<DevTeam launch directory>/checklists/<domain>.md`.

- `domainChecklist` holds only the **critical** lines, inlined because missing one means a breach, a
  bill or an outage. It is not the whole list.
- **Open the files in `checklistFiles`** and walk the sections your change touches, then name them in
  `checklistSections`. Do not claim sections you did not read.
- **Never edit these files.** If a line is missing, say so in your report or as a `rule` on a finding;
  the owner decides.

With no domain selected there is no domain checklist at all, and in practice the human rarely ticks
one. **That makes choosing domains the planner's job** (see Planning).

## Planning work

Plan when you hold a planner assignment. Inspect the project and the task first; a plan built on the
task text alone is a guess. Then put each piece of work on the board with `devteam_plan`:

- `title` and a `description` that stands alone: what to change, where, what done looks like, and how
  to exercise it. The assignee sees the description, not your reasoning.
- `role`, and `requiresWrite=true` with `paths` for anything that edits files. Declared paths let
  non-overlapping writers run at once; without them the writer takes a whole-project lease.
- `dependsOn` — empty starts now, in parallel; naming earlier assignments makes it wait for them.
  Declare the real order: the scheduler runs anything without a dependency as soon as its paths
  are free, and the board only guesses the shape from creation times when you leave it out.
- `targetAgentName` when the human or the team decided who does it.
- **`domains` — choose them on purpose.** The tool description lists the checklists the owner has
  written. Pick the ones this work actually belongs to (a dashboard change is `web-frontend`; an auth
  or input-handling change also wants `security`). Omitting it inherits the task's domains, which are
  usually none. `[]` means none on purpose. A wrong domain is worse than none: it hands the reviewer
  the wrong list.
- For each piece of write work, a reviewer assignment with `reviewSubjectAssignmentId` set to it, so
  its author stays ineligible, and the same id in `dependsOn`, so the review waits for that work.
  If an open review of that work already exists, DevTeam returns it (`duplicateOf`) instead of
  making a second one.
- `checklist` only when this piece of work needs specific points checked: it replaces the role's
  default checklist (`[]` removes it). Domain checklists still come from `domains`. The task needs its `required_approvals` count of approvals, and no open
  assignments, to be accepted.

Then report your planner assignment with a summary of the plan.

## Checking each other

**You will never be handed a review of your own work.** If nobody independent exists, acceptance is
labelled `selfReviewed` rather than passed off as consensus.

A review is two calls. First do the review read-only (read the diff and the files, run the tests),
then `devteam_report` your reviewer assignment with **no** `changedFiles`. Only then give the verdict
with `devteam_verdict`, which needs that completed read-only review on the current version:

- `verdict=approve` with a `summary` naming what you checked and what you ran.
- `verdict=changes` with the author's `assignmentId` (not your own) and concrete `findings`: what must
  change and why, with the `path` where it applies. The author gets them on re-claim. When a finding
  is a general lesson, add `rule` (one short, testable sentence with no task-specific names) and
  `section` (Security, Testing, Data, Performance, UX…); the owner decides whether it earns a line
  in `checklists/`.

**Sending work back is normal.** Approving work you doubt is the failure. If you must fix something
yourself, that is new write work, not a review; put it on the board.

## When you cannot proceed

`devteam_stuck kind=why` returns the scheduler's real reason chain (the writer you are waiting on, an
overlapping lease, an unmet dependency, that you wrote the version under review). Ask it rather than
guessing.

Every other kind **stops the whole task**: all teammates are stood down and only the human can restart
it. Use it only for a genuine task-wide blocker and give a `reason` the human can act on:
`needs-human` (a decision or authorization only the owner can give), `over-my-head` (the work exceeds
the model or effort you are running; name the capability needed), `misrouted`, `external`. One bad
assignment is not a task blocker: report it `status=blocked`. **Finishing is not stopping**: report,
and let review close the task.

DevTeam does not judge whether work is beyond you. If you know you are outmatched, say so; a confident
wrong answer costs far more than a stopped assignment.

## Staying reachable

Messages ride along on **any** call as `pendingMessages`. Read them, and reply with `devteam_message`
before carrying on: omit `target` for the room, set it to a teammate's name to push it to them, pass
`replyTo` with an event id to thread. Use `kind` (`progress`, `decision`, `finding`, `question`) so the
timeline reads right. Keep progress notes for moments that matter to others; the report is where the
detail goes.

## Working alone

The loop still holds: do the work, then review it in a separate read-only pass and say plainly it was
self-reviewed. Be a harder reviewer of yourself, not a friendlier one.

## Leaving

`devteam_leave` with a short summary when the task is accepted, blocked, or the room has gone quiet.
You can also pass `disconnectAfter=true` on your last report. Do not leave holding a claim you could
finish, and do not idle in the room for long stretches.
