import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const textResult = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});

const errorResult = (error) => ({
  isError: true,
  content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
});

const safe = (handler) => async (args) => {
  try {
    return textResult(await handler(args));
  } catch (error) {
    return errorResult(error);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createDevTeamMcpServer(store, session = { agentId: null }) {
  const server = new McpServer({ name: "devteam", version: "0.2.0" }, {
    instructions: "DevTeam coordinates local AI development agents. Connect once, claim only assigned work, inspect the real project, report concrete changes and checks, request independent review, approve only the current version, and disconnect after acceptance or a blocker. Never push, deploy, publish, or perform destructive actions without explicit human approval in DevTeam.",
    capabilities: { logging: {} },
  });

  // Identity is bound to the MCP session that connected, not to the caller-supplied agentId.
  // Without this, any client sharing the bearer token could pass another agent's id and speak,
  // vote, approve, or disconnect as them — making the timeline's provenance untrustworthy.
  const requireIdentity = (agentId) => {
    if (!session.agentId) throw new Error("This MCP session has not connected. Call devteam_join first.");
    if (agentId !== session.agentId) throw new Error("Identity mismatch: an MCP session may only act as the agent it connected as.");
  };

  // Reachability: piggyback any directed/broadcast messages waiting for this agent onto whatever
  // call it just made, so a *busy* agent (not sitting in devteam_next) is still reached promptly
  // instead of only when it next goes idle.
  const takeInbox = (agentId) => {
    let pendingMessages = [];
    try { pendingMessages = store.deliverDirectedMessages(agentId); } catch { pendingMessages = []; }
    return { pendingMessages };
  };
  const withInbox = (agentId, result) => {
    const { pendingMessages } = takeInbox(agentId);
    // Human steering rides along on whatever call the agent just made, for the same reason messages
    // do: an agent deep in a long edit is not sitting in devteam_next, and "stop, this is no longer
    // worth doing" is worthless if it only arrives when the agent next goes idle.
    let steering = null;
    try { steering = store.steeringFor(agentId); } catch { steering = null; }
    if (!pendingMessages.length && !steering) return result;
    return {
      ...result,
      ...(pendingMessages.length ? { pendingMessages } : {}),
      ...(steering ? { steering } : {}),
    };
  };

  // Arriving. Four tools — connect, join, resume, roles — were four ways of saying "I am here, put
  // me in the room", and an agent had to get the order right before it could do anything at all.
  // Now one call covers a first arrival, joining a further room, and coming back after a dropped
  // session, and it answers with the project's own role vocabulary so nobody has to ask separately.
  server.registerTool("devteam_join", {
    title: "Join the team",
    description: "Call this first. With name and provider you arrive as a new session; add taskId to enter that task's room at the same time. Membership is always explicit — until you are in a room, nothing on the board is claimable by you, and the reply lists the rooms you could join. Keep the returned agentId and resumeToken privately: if the session drops, call again with your new agentId plus that resumeToken to reclaim the work, room and missed messages of the old one rather than leaving its claim stuck. Already connected and want another room? Pass your agentId and the taskId. The reply also carries the three roles work moves through: planner → implementer → reviewer. A reviewer reads work rather than changing it, so it waits for pending writers and earns the right to pass a verdict; a planner decides what the team does next. Security review is a reviewer assignment with the security domain selected, not a role of its own. When you enter a room the reply carries the project's team: the agents named for each role are the only ones handed that role's work (an empty list means anyone), and soloReview says whether an author may review its own work when nobody else can — when it is false, a review of your work waits for someone else.",
    inputSchema: {
      name: z.string().min(1).max(80).optional().describe("Your display name on a first arrival, for example Codex or Claude"),
      provider: z.string().min(1).max(80).optional().describe("Your host on a first arrival, for example OpenAI Codex or Anthropic Claude Code"),
      capabilities: z.array(z.string().max(80)).max(20).default([]).describe("What you are good at — implementation, review, security, testing, research. DevTeam matches these to work; it never appoints you to a role you did not claim."),
      model: z.string().max(80).optional().describe("The model you are running as right now, in the name a human would recognise — \"Sonnet 5\", \"Opus 5\". Recorded so the board says who did what; it gates nothing."),
      effort: z.string().max(40).optional().describe("The effort or thinking level you are running at right now — low, medium, high, maximum — if your host exposes one."),
      taskId: z.string().uuid().optional().describe("The task room to enter"),
      role: z.enum(["contributor", "observer"]).default("contributor").describe("Observers watch and never claim work"),
      agentId: z.string().uuid().optional().describe("Your existing agentId, when joining a further room or resuming"),
      resumeToken: z.string().max(200).optional().describe("The resumeToken from the session you are reclaiming, alongside your new agentId"),
    },
  }, safe(async (args) => {
    const { name, provider, capabilities, taskId, role, agentId, resumeToken, model, effort } = args;
    // Resuming and joining act as an already-connected agent; arriving is the one call that has no
    // identity yet, and it is what establishes one for this MCP session.
    if (resumeToken) {
      if (!agentId) throw new Error("Resuming needs the agentId from your current arrival, plus the earlier session's resumeToken.");
      requireIdentity(agentId);
      return withInbox(agentId, store.resumeAgent({ agentId, resumeToken }));
    }
    if (agentId) {
      requireIdentity(agentId);
      if (!taskId) throw new Error("Pass taskId to say which room you are joining.");
      const joined = store.joinTask(agentId, taskId, role);
      const task = store.getTask(taskId);
      return withInbox(agentId, {
        ...joined,
        roles: task ? store.roleCatalogue() : null,
        ...(task ? { team: store.teamSummary(task.project_id) } : {}),
      });
    }
    if (!name || !provider) throw new Error("A first arrival needs name and provider.");
    const agent = store.connectAgent({ name, provider, capabilities, freshTaskId: taskId || null, model, effort });
    session.agentId = agent.id;
    const { resumeToken: token, room, ...agentInfo } = agent;
    const roomStatus = store.roomStatusForAgent(agent.id);
    const roomRequired = roomStatus.joinedTaskIds.length === 0 && roomStatus.activeTasks.length > 0;
    const task = taskId ? store.getTask(taskId) : null;
    return {
      connected: true,
      agent: agentInfo,
      room,
      ...(task ? { roles: store.roleCatalogue(), team: store.teamSummary(task.project_id) } : {}),
      ...(roomRequired ? { roomRequired: true, availableTasks: roomStatus.activeTasks } : {}),
      resumeToken: token,
      next: roomRequired
        ? "You are in no room, so nothing is claimable. Pick the intended task from availableTasks and call devteam_join again with your agentId and that taskId, then devteam_next. Keep resumeToken privately."
        : "Call devteam_next with this agentId. Keep resumeToken privately: if this session drops, join again and pass it to reclaim this session's work and missed messages.",
    };
  }));

  server.registerTool("devteam_next", {
    title: "Get your next piece of work, or look something up",
    description: "Your main loop. With no arguments beyond agentId it blocks locally until DevTeam has an assignment or a message for you — no model tokens are spent while blocked — and returns everything you need to start: the task, your assignment with its claim token, write scope and checklist, the relevant project memory, a map of the code around it, recent decisions and open questions. Returns 'room_required' if you are in no room yet, 'assigned' or 'message' when something arrives, or 'idle' after the timeout. The other modes are lookups, and none of them blocks: want=board (with taskId) is the board as a short flowchart in text — every step, who has it, what it waits on, and the ids to act on — and is what to read to see where the work stands; want=state returns the whole task including every event, which is large, so use it only when you need an event id or the full history; want=brief re-reads the full briefing for a task you are already working; and want=module returns the one-hop neighbourhood of a file from the code graph (paths, purposes and symbols, never source).",
    inputSchema: {
      agentId: z.string().uuid(),
      want: z.enum(["work", "board", "state", "brief", "module"]).default("work"),
      timeoutSeconds: z.number().int().min(1).max(50).default(45).describe("want=work only: how long to block before answering idle"),
      taskId: z.string().uuid().optional().describe("Required for board, brief and module; optional for state to narrow it to one task"),
      path: z.string().max(500).optional().describe("want=module: the project-relative file whose neighbours you want"),
    },
  }, safe(async ({ agentId, want, timeoutSeconds, taskId, path: modulePath }) => {
    // The lookups first: they are the same act as waiting — "tell me what I need to work" — but
    // answered from what DevTeam already knows instead of by blocking for something new.
    if (want === "board") {
      requireIdentity(agentId);
      store.heartbeat(agentId);
      if (!taskId) throw new Error("want=board needs taskId.");
      store.assertMembership(agentId, taskId);
      return withInbox(agentId, store.boardText(taskId));
    }
    if (want === "state") {
      requireIdentity(agentId);
      store.heartbeat(agentId);
      if (taskId) store.assertMembership(agentId, taskId);
      return withInbox(agentId, taskId ? store.taskDetail(taskId) : store.snapshotForAgent(agentId));
    }
    if (want === "brief") {
      requireIdentity(agentId);
      store.heartbeat(agentId);
      if (!taskId) throw new Error("want=brief needs taskId.");
      const { pendingMessages } = takeInbox(agentId);
      return store.taskBrief(agentId, taskId, { pendingMessages });
    }
    if (want === "module") {
      requireIdentity(agentId);
      if (!taskId || !modulePath) throw new Error("want=module needs taskId and path.");
      return withInbox(agentId, store.codeGraphSearch({ agentId, taskId, path: modulePath }));
    }
    requireIdentity(agentId);
    store.heartbeat(agentId, "waiting");
    // A stop request or a blown budget outranks waiting for more work: an agent should not sit in a
    // long poll for 45 seconds after the human has asked it to stop.
    const steering = store.steeringFor(agentId);
    if (steering) {
      return { status: "steering", keepWaiting: false, steering, next: steering.next || "Act on this before waiting again." };
    }
    const initialRoomStatus = store.roomStatusForAgent(agentId);
    if (initialRoomStatus.joinedTaskIds.length === 0 && initialRoomStatus.activeTasks.length > 0) {
      return {
        status: "room_required",
        keepWaiting: false,
        availableTasks: initialRoomStatus.activeTasks,
        message: "You have joined no task room, so no work here is claimable by you. Choose the intended taskId from availableTasks and call devteam_join before waiting.",
        next: "Call devteam_join with this agentId, the intended taskId, and role contributor; then call devteam_next again.",
      };
    }
    const deadline = Date.now() + timeoutSeconds * 1000;
    do {
      // Live human messages take priority: the user is actively trying to reach this agent.
      const messages = store.deliverDirectedMessages(agentId);
      if (messages.length) {
        return {
          status: "message",
          messages,
          keepWaiting: true,
          next: "Read these messages. If a reply or acknowledgement is expected, post it with devteam_message, then call devteam_next again to stay responsive to the team.",
        };
      }
      const assignment = store.claimNextAssignment(agentId);
      if (assignment) {
        return store.taskBrief(agentId, assignment.task_id, {
          currentAssignment: assignment,
          assignmentKey: "assignment",
          responseCore: {
            status: "assigned",
            keepWaiting: true,
            instructions: "Inspect the current project state before acting. Complete this bounded assignment, then call devteam_report — pass back assignment.claimToken so a stale report is fenced if your lease moved. Use devteam_plan to delegate follow-up implementation, testing, or independent review.",
          },
        });
      }
      store.heartbeat(agentId, "waiting");
      await sleep(Math.min(750, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    const activity = store.teamActivityForAgent(agentId);
    // Work that only an absent teammate may take is not a reason to keep polling: nobody in the room
    // can move it until the owner brings that teammate back, and every idle round costs tokens.
    const heldForAbsent = activity.workingAgents || activity.busyAgents ? [] : store.workWaitingOnAbsentTeammates(agentId);
    if (heldForAbsent.length) {
      const names = [...new Set(heldForAbsent.flatMap((item) => item.waitingFor))];
      return {
        status: "idle",
        keepWaiting: false,
        activity,
        waitingOnTeammates: heldForAbsent,
        message: `Nothing here is yours to take. ${heldForAbsent.length === 1 ? "One assignment is" : `${heldForAbsent.length} assignments are`} waiting for ${names.join(" or ")}, who ${names.length === 1 ? "is" : "are"} not connected.`,
        next: `Tell the user that ${names.join(" or ")} is needed, then call devteam_leave. The user will bring you back when there is work for you.`,
      };
    }
    // A room the human blocked looks exactly like a finished one from here: no work, no busy
    // teammates. Say which task is stopped and that only the human can restart it, so the idle
    // answer cannot be read as "the team is done" or as licence to recreate the task elsewhere.
    const blockedRooms = store.blockedRoomsForAgent(agentId);
    if (blockedRooms.length && !activity.active) {
      return {
        status: "idle",
        keepWaiting: false,
        activity,
        blockedRooms,
        message: `Nothing is claimable because ${blockedRooms.length === 1 ? "this task is blocked" : "these tasks are blocked"}: ${blockedRooms.map((room) => `"${room.taskTitle}"${room.reason ? ` — ${room.reason}` : ""}`).join("; ")}.`,
        next: blockedRooms[0].agentAction,
      };
    }
    return {
      status: "idle",
      keepWaiting: activity.active,
      activity,
      ...(blockedRooms.length ? { blockedRooms } : {}),
      message: activity.active
        ? "No work for you yet, but the team is still active (work is in flight or teammates are busy). Call devteam_next again to stay assembled. If you have been idle with no assignment or message for about five minutes straight, disconnect and tell the user to invoke $devteam again when there is new work."
        : "The room is quiet: no open assignments and no busy teammates. Disconnect to save the session; the user can reconnect this agent when new work is ready.",
    };
  }));

  server.registerTool("devteam_message", {
    title: "Post a team message",
    description: "Post a focused progress note, design decision, review finding, or question. Omit target to say it to the whole room — every teammate in it receives it on their next call; set target to a teammate's name to send it to them alone. Pass replyTo (a timeline event id) to answer a specific message as a thread. Keep room messages for what teammates need to know: they are delivered, so each one costs everyone a read.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      message: z.string().min(1).max(12000),
      kind: z.enum(["progress", "decision", "finding", "question"]).default("progress"),
      target: z.string().max(80).optional().describe("Direct this message to one teammate by name; omit to broadcast it to the room's timeline."),
      replyTo: z.number().int().positive().optional().describe("Timeline event id this message replies to"),
    },
  }, safe(async ({ agentId, taskId, message, kind, target, replyTo }) => {
    requireIdentity(agentId);
    const metadata = { ...(replyTo ? { replyTo } : {}), ...(target ? { target } : {}) };
    return withInbox(agentId, store.postMessage({ agentId, taskId, message, type: `agent.${kind}`, metadata }));
  }));

  // Putting work on the board.
  const planCard = z.object({
    key: z.string().max(40).optional().describe("A name for this card inside the batch, so later cards can wait on it or review it before it has an id"),
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(12000),
    role: z.enum(["planner", "implementer", "reviewer"]).default("implementer"),
    requiresWrite: z.boolean().default(false),
    targetAgentName: z.string().max(80).optional(),
    paths: z.array(z.string().max(500)).max(50).optional(),
    dependsOn: z.array(z.string().max(60)).max(50).optional().describe("Keys of earlier cards in this batch, or ids of cards already on the board"),
    reviews: z.string().max(60).optional().describe("For a reviewer card: the key (or id) of the card it reviews"),
    checklist: z.array(z.string().max(300)).max(40).optional(),
    domains: z.array(z.string().max(30)).max(20).optional(),
  });

  server.registerTool("devteam_plan", {
    title: "Put work on the board, or fix a card that is already there",
    description: "action=create (the default) puts a bounded assignment on the board for whoever can take it. There are three roles and work moves through them in one direction: planner → implementer → reviewer. Order is the only other scheduling vocabulary you need: leave dependsOn empty and it can start now, in parallel with anything else that is ready; name earlier assignments and it waits for them. Declare `paths` for write work so non-overlapping writers run at the same time instead of queueing behind one lease. A reviewer assignment carries a checklist automatically. Pass `cards` instead of a single title to put a whole plan on the board at once: each card may name earlier cards in the same batch by `key` in dependsOn and reviews, which is how the real order gets declared. Fix cards instead of copying them: action=reopen puts a blocked or closed card back in the queue (optionally with targetAgentName and a note), keeping everything that waits on it; action=edit changes a waiting card's title, description, targetAgentName or dependsOn; action=close takes a card off the board with a reason, and with replacedBy moves everything that waited on it (and any review of it) to the replacement. When work is sent back, its review card returns by itself as the next round — do not create a re-review.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      action: z.enum(["create", "edit", "reopen", "close"]).default("create"),
      assignmentId: z.string().uuid().optional().describe("edit/reopen/close: the card to change"),
      reason: z.string().max(1000).optional().describe("close: why it is coming off the board"),
      replacedBy: z.string().uuid().optional().describe("close: the card that takes its place; its waiters and reviews move there"),
      note: z.string().max(4000).optional().describe("reopen: what the next holder should know, appended to the description"),
      cards: z.array(planCard).max(30).optional().describe("create: several cards at once, in the order they happen"),
      title: z.string().min(1).max(160).optional().describe("Assignment title"),
      description: z.string().max(12000).optional(),
      role: z.enum(["planner", "implementer", "reviewer"]).default("implementer").describe("planner decides what the team does next (and researches whatever it needs to decide); implementer produces the work and exercises it; reviewer reads someone else's finished work and judges it. A reviewer assignment is never handed to whoever wrote the version under review, unless the project turned solo mode on. If the project's team names agents for this role, only they (or the targetAgentName) are handed it. Security work is a reviewer assignment with the security domain selected."),
      requiresWrite: z.boolean().default(false),
      targetAgentName: z.string().max(80).optional().describe("Address it to one teammate by name. If nobody by that name is connected it returns to the queue, where only the agents the project's team names for this role may take it (anyone, if the team names nobody)."),
      reviewSubjectAssignmentId: z.string().uuid().optional().describe("For a verifying assignment: the same-task assignment being reviewed. This keeps its author ineligible even after unrelated later edits."),
      checklist: z.array(z.string().max(300)).max(40).optional().describe("Points the assignee must address; overrides the role's default checklist, and an empty array omits it"),
      paths: z.array(z.string().max(500)).max(50).optional().describe("For write work: the paths this will modify (e.g. src/ocean/**). Declaring them lets non-overlapping writers run in parallel; omit for an exclusive whole-project lease."),
      dependsOn: z.array(z.string().uuid()).max(50).optional().describe("Same-task assignment IDs that must finish first. Empty means it can run now."),
      domains: z.array(z.string().max(30)).max(20).optional().describe(`The domains this work belongs to, which choose which of the owner's checklists (checklists/<domain>.md) verifying roles are handed. A domain exists only if the owner wrote its file; right now: ${store.domainNames().join(", ") || "none — the owner has written no checklists"}. An unknown name is refused with the current list. Omit to inherit the task's domains; an empty array means none.`),
    },
  }, safe(async (args) => {
    const { agentId, taskId, title, description, role, requiresWrite, targetAgentName } = args;
    requireIdentity(agentId);
    if (args.action !== "create") {
      if (!args.assignmentId) throw new Error(`action=${args.action} needs the assignmentId of the card to change.`);
      if (args.action === "reopen") {
        return withInbox(agentId, store.reopenAssignment({ agentId, taskId, assignmentId: args.assignmentId, targetAgentName, note: args.note }));
      }
      if (args.action === "close") {
        return withInbox(agentId, store.closeAssignment({ agentId, taskId, assignmentId: args.assignmentId, reason: args.reason, replacedBy: args.replacedBy || null }));
      }
      return withInbox(agentId, store.editAssignment({ agentId, taskId, assignmentId: args.assignmentId, title, description, targetAgentName, dependsOn: args.dependsOn }));
    }
    if (args.cards?.length) return withInbox(agentId, store.planBatch({ agentId, taskId, cards: args.cards }));
    if (!title || !description) throw new Error("An assignment needs a title and a description.");
    const created = store.createAssignment({
      agentId, taskId, title, description, role, requiresWrite, targetAgentName,
      checklist: args.checklist, paths: args.paths, dependsOn: args.dependsOn, reviewSubjectAssignmentId: args.reviewSubjectAssignmentId,
      domains: args.domains,
    });
    return withInbox(agentId, created.duplicateOf ? {
      ...created,
      next: `No duplicate review was created: ${created.message}`,
    } : created);
  }));

  server.registerTool("devteam_memory", {
    title: "Project memory",
    description: "The project's memory. A note exists only because somebody wrote it — here with action=write, or in the learned field of devteam_report — and your brief already carries the most relevant notes as headlines. action=search fetches the full body of a note the brief only summarised, or finds notes by words, path or category — reach for it whenever a headline looks relevant. action=write records a fact the next person would otherwise rediscover: an API limit, why the obvious approach fails here, a convention the code follows but never states. Not a progress update and not a decision the team took — post those with devteam_message. action=get and action=set are a small versioned key/value scratchpad — scope=task for this job, scope=project to persist across the project's tasks; re-read and merge on a version conflict.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      action: z.enum(["search", "write", "get", "set"]).default("search"),
      query: z.string().max(500).default("").describe("search: words, a file path, a component or a decision; empty returns the most relevant recent notes"),
      category: z.enum(["architecture", "decisions", "components", "conventions", "pitfalls", "workflows", "archive"]).optional()
        .describe("search: narrow to one kind. write: required — architecture (how it fits together), decisions (a choice and its reason), components (what one part does), conventions (a rule the project follows), pitfalls (what will bite the next person), workflows (how a recurring job is done)."),
      limit: z.number().int().min(1).max(50).default(20).describe("search only"),
      title: z.string().min(1).max(200).optional().describe("write: the fact as a statement, not a topic — 'The billing API rate-limits at 30 requests/minute', not 'Billing API'"),
      body: z.string().min(1).max(4000).optional().describe("write: the fact with enough context to act on. Link related notes inline with [[category/slug]] and they become navigable both ways."),
      confidence: z.enum(["low", "medium", "high"]).default("medium").describe("write: be honest — a low-confidence note is still worth recording and is ranked accordingly. Notes you write are recorded as 'inferred'; verified means DevTeam observed it."),
      relatedFiles: z.array(z.string().max(500)).max(20).default([]).describe("write: project-relative files this fact concerns, so it goes stale when they change"),
      scope: z.enum(["task", "project"]).default("task").describe("get/set only"),
      key: z.string().max(120).optional().describe("get/set: e.g. 'world', 'open-questions', 'ownership'. Omit on get to list the keys."),
      value: z.string().min(0).max(100000).optional().describe("set: the new content, plain text or a JSON string"),
      expectedVersion: z.number().int().min(0).optional().describe("set: the version you last read; omit only for a first write you know is uncontended"),
    },
  }, safe(async (args) => {
    const { agentId, taskId, action } = args;
    requireIdentity(agentId);
    if (action === "write") {
      if (!args.category || !args.title || !args.body) {
        throw new Error("action=write needs category, title and body.");
      }
      return withInbox(agentId, store.knowledgeWrite({
        agentId, taskId, category: args.category, title: args.title, body: args.body,
        confidence: args.confidence, relatedFiles: args.relatedFiles,
      }));
    }
    if (action === "set") {
      if (!args.key || args.value === undefined) throw new Error("action=set needs key and value.");
      return withInbox(agentId, store.noteSet({
        agentId, taskId, scope: args.scope, key: args.key, value: args.value,
        expectedVersion: args.expectedVersion ?? null,
      }));
    }
    if (action === "get") {
      store.assertMembership(agentId, taskId);
      if (args.key) {
        const note = store.noteGet(taskId, args.key, args.scope, agentId);
        return withInbox(agentId, note || { scope: args.scope, key: args.key, value: null, version: 0, missing: true });
      }
      return withInbox(agentId, { scope: args.scope, keys: store.noteList(taskId, args.scope, agentId) });
    }
    return withInbox(agentId, store.knowledgeSearch({
      agentId, taskId, query: args.query, category: args.category ?? null, limit: args.limit,
    }));
  }));

  server.registerTool("devteam_report", {
    title: "Report completed work",
    description: "Complete the currently claimed assignment with evidence. Report exact files and checks; changed files advance the task version and invalidate prior approvals. DevTeam does not run anything itself — a check is your word, so say plainly whether each one passed or failed. Reporting a check as failed while reporting the work as done is refused, and your claim is left intact so you can fix it and report again; report status=blocked instead if you cannot. DevTeam compares each check against what the task last recorded for it, so a check you report as failing that someone previously reported as passing is raised as a regression and a fix is routed to whoever changed files since. status=blocked closes only this assignment and queues planner triage; use devteam_stuck separately only for a genuine task-wide blocker.",
    inputSchema: {
      agentId: z.string().uuid(),
      assignmentId: z.string().uuid(),
      message: z.string().min(1).max(16000),
      status: z.enum(["done", "blocked"]).default("done").describe("blocked applies only to this assignment and queues planner triage; it does not stop the task"),
      changedFiles: z.array(z.string().max(500)).max(200).default([]),
      checks: z.array(z.union([
        z.string().max(500).describe("A bare assertion, recorded as your word with no pass/fail claim either way. It moves no baseline, so prefer the object form when you actually ran something."),
        z.object({
          label: z.string().min(1).max(500).describe("What you ran, named the same way each time — for example \"npm test\". This label is what DevTeam compares against the task's history, so a different name is a different check."),
          status: z.enum(["passed", "failed"]).optional().describe("What it did. Omit only when you are not claiming an outcome; an unrecognized value is recorded as a bare assertion rather than guessed."),
        }),
      ])).max(100).default([]),
      disconnectAfter: z.boolean().default(false),
      claimToken: z.string().max(200).optional().describe("The claimToken from the assignment you claimed (or from devteam_join when you resumed). Lets the server fence a stale report if your lease has since moved."),
      checklistSections: z.array(z.string().max(80)).max(20).default([]).describe("If your brief carried checklistFiles, name the sections of those files you actually walked (the `## ` headings). Walk the ones your change touches, not all of them. This is recorded in the task timeline as your claim about what you checked."),
      learned: z.array(z.object({
        category: z.enum(["architecture", "decisions", "components", "conventions", "pitfalls", "workflows"])
          .describe("architecture (how it fits together), decisions (a choice and its reason), components (what one part does), conventions (a rule the project follows), pitfalls (what will bite the next person), workflows (how a recurring job is done)"),
        title: z.string().min(1).max(200).describe("The fact as a statement, not a topic — 'The billing API rate-limits at 30 requests/minute', not 'Billing API'"),
        body: z.string().min(1).max(4000).describe("The fact with enough context for the next person to act on it"),
      })).max(3).default([]).describe("What this work taught you that the next person would otherwise rediscover: an API limit, why the obvious approach fails here, a convention the code follows but never states. Recorded as project memory and delivered in future briefs. Omit it when the work taught you nothing durable — most work does not, and an empty list is the honest answer."),
    },
  }, safe(async ({ disconnectAfter, ...args }) => {
    requireIdentity(args.agentId);
    const result = await store.completeAssignment({
      ...args,
      nextStatus: disconnectAfter ? "disconnected" : "waiting",
    });
    return disconnectAfter ? result : withInbox(args.agentId, result);
  }));

  server.registerTool("devteam_verdict", {
    title: "Pass judgement on someone else's work",
    description: "Your verdict on work you reviewed. verdict=approve accepts the current task version — only after you completed an independent read-only reviewer assignment on it, and never on a version you wrote yourself; DevTeam will not hand you that review in the first place. verdict=changes sends one assignment back to whoever wrote it with your findings attached, keeping its title, checklist, write scope and history; the author is handed your findings when it re-claims, approvals on the version are cleared, and nobody else's claim is touched. Sending work back is a normal outcome, not a failure — approving work you have doubts about is the failure.",
    inputSchema: {
      agentId: z.string().uuid(),
      verdict: z.enum(["approve", "changes"]),
      taskId: z.string().uuid().optional().describe("approve/changes"),
      summary: z.string().max(8000).optional().describe("approve: what you checked and found. changes: one line on why this is going back."),
      assignmentId: z.string().uuid().optional().describe("changes: the completed assignment that needs work — the author's, not your own review assignment"),
      findings: z.array(z.union([
        z.string().max(2000).describe("One thing that must change"),
        z.object({
          detail: z.string().min(1).max(2000).describe("What must change and why"),
          path: z.string().max(500).optional().describe("The project-relative file it concerns, when it concerns one"),
          rule: z.string().max(200).optional().describe("The same finding restated as one short, general, testable rule (no task-specific names). Recorded with the finding as a lesson; the owner decides whether it earns a line in the project's checklists. Omit if it is not a general lesson."),
          section: z.string().max(40).optional().describe("The section the rule would belong under, e.g. Security, Testing, Data, Performance, UX"),
        }),
      ])).max(50).default([]).describe("changes: the specific changes required. The author is handed this list on re-claim, so be concrete — and DevTeam reads them across tasks to notice conventions this project keeps having to state."),
    },
  }, safe(async (args) => {
    const { agentId, verdict, taskId, summary, assignmentId, findings } = args;
    requireIdentity(agentId);
    if (!taskId) throw new Error(`verdict=${verdict} needs taskId.`);
    if (!summary) throw new Error(`verdict=${verdict} needs a summary saying why.`);
    if (verdict === "approve") return withInbox(agentId, store.approveTask({ agentId, taskId, summary }));
    if (!assignmentId) throw new Error("verdict=changes needs the assignmentId of the work going back.");
    return withInbox(agentId, store.requestChanges({ agentId, taskId, assignmentId, summary, findings }));
  }));

  server.registerTool("devteam_stuck", {
    title: "Say you cannot proceed, or ask why",
    description: "kind=why asks the scheduler for the full ordered reason chain instead of guessing — omit assignmentId for everything queued in your rooms, or pass one to ask about a specific item. The reason codes name the actual blocker: the writer you are waiting on, an overlapping write lease, each unmet dependency, or that you wrote the version you are being asked to check. The other kinds STOP THE WHOLE TASK, which is the heaviest thing you can do: every teammate is stood down, all open work is closed, and only the human can reopen it from the dashboard. needs-human is a decision or authorization only the owner can give; over-my-head means the work exceeds the model or effort you are running, so say what capability is needed; misrouted means this cannot correctly be done by you; external means something outside the project must change first. Finishing is NOT stopping — when the work is done, report it and pass a verdict. One bad assignment is not a task blocker either: report that assignment with status=blocked and the task keeps running.",
    inputSchema: {
      agentId: z.string().uuid(),
      kind: z.enum(["why", "needs-human", "over-my-head", "misrouted", "external"]).default("why"),
      taskId: z.string().uuid().optional().describe("Required to stop a task; optional with kind=why to narrow the answer to one room"),
      reason: z.string().max(8000).optional().describe("Required to stop a task: what you need, concretely enough for the human to act on"),
      assignmentId: z.string().uuid().optional().describe("kind=why: ask about one specific queued assignment"),
    },
  }, safe(async (args) => {
    const { agentId, kind, taskId, reason, assignmentId } = args;
    requireIdentity(agentId);
    if (kind !== "why") {
      if (!taskId) throw new Error(`kind=${kind} stops a task, so it needs taskId.`);
      if (!reason) throw new Error(`kind=${kind} needs a reason the human can act on.`);
      return store.blockTask({ agentId, taskId, reason, kind });
    }
    store.heartbeat(agentId);
    if (!assignmentId) return withInbox(agentId, store.whyNoClaimableWork(agentId, taskId || null));
    // Authorize before computing: whyNotClaimable resolves write scopes on disk, and an unauthorized
    // caller should not be able to spend that work — nor tell a missing assignment from a private one.
    const room = store.assignmentRoom(assignmentId);
    if (!room) throw new Error("You are not a member of this task room. Call devteam_join first.");
    store.assertExplainable(agentId, room);
    return withInbox(agentId, store.whyNotClaimable(assignmentId, agentId));
  }));

  server.registerTool("devteam_leave", {
    title: "Disconnect from DevTeam",
    description: "End this desktop agent session after work is finished, blocked, or no longer needed.",
    inputSchema: {
      agentId: z.string().uuid(),
      summary: z.string().max(4000).default(""),
    },
  }, safe(async ({ agentId, summary }) => {
    requireIdentity(agentId);
    const result = store.disconnectAgent(agentId, summary);
    session.agentId = null;
    return result;
  }));

  return server;
}
