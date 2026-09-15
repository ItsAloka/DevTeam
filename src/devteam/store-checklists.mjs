// Self-growing domain checklists (SKILLS_PLAN.md §5): the lifecycle of an item from a reviewer's
// finding to an active rule, and back out again once it stops earning its place in a brief.
//
// Composed onto DevTeamStore.prototype like the other store-*.mjs clusters (through consensusMethods,
// which owns the one place findings are written). There is deliberately no second findings system:
// the evidence for an item is the assignment_findings rows linked to it, and "the same objection"
// is decided by the same findingSignature the recurring-convention notes in knowledge.mjs use.
//
// Delivery into briefs and report marking are a separate assignment; this file provides the hooks
// they call (_recordChecklistDelivery, markChecklistItem) and the expiry that reads their results.
import { randomUUID } from "node:crypto";
import { now } from "./util.mjs";
import { CONVENTION_MIN_TASKS, findingSignature, redact } from "./knowledge.mjs";

export const CHECKLIST_RULE_MAX = 200;
const SECTION_MAX = 40;
const DEFAULT_SECTION = "General";
// Recurrence: the same item raised on this many distinct tasks. Shared with the convention notes.
export const CHECKLIST_RECURRENCE_TASKS = CONVENTION_MIN_TASKS;
// Cross-validation: this many distinct checkers independently raising it on the same task.
export const CHECKLIST_CROSS_CHECKERS = 2;
// Not-applicable expiry is automatic: a rule checkers keep calling irrelevant is noise.
export const CHECKLIST_NA_WINDOW = 10;
export const CHECKLIST_NA_RATIO = 0.6;
// Learned expiry is only *proposed*: dropping a security rule silently is the costly mistake, so
// the owner confirms it.
export const CHECKLIST_LEARNED_DELIVERIES = 20;
export const CHECKLIST_LEARNED_QUIET_DAYS = 90;

const TRANSITIONS = {
  candidate: ["active", "merged", "rejected"],
  active: ["expired", "merged"],
  expired: ["active", "merged"],
  rejected: ["candidate"],
  merged: [],
};

const cleanRule = (value) => redact(String(value ?? "")).replace(/\s+/gu, " ").trim().slice(0, CHECKLIST_RULE_MAX);
const cleanSection = (value) => {
  const text = redact(String(value ?? "")).replace(/\s+/gu, " ").trim().slice(0, SECTION_MAX);
  return text || DEFAULT_SECTION;
};
// The key an item is matched on. The word-bag signature where the text is long enough to have one;
// otherwise the normalised text itself, so a short rule is still deduplicated exactly.
const itemSignature = (text) => findingSignature(text) || String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export const checklistMethods = {
  // Called inside requestChanges' transaction with the findings it just stored. Each finding on a
  // task that declares domains becomes (or adds evidence to) a shared item per domain. A task with
  // no domains captures nothing, so such a project behaves exactly as before.
  _captureChecklistCandidates(task, findings) {
    const domains = Array.isArray(task.domains) ? task.domains : [];
    if (!domains.length || !findings.length) return [];
    const touched = new Set();
    for (const finding of findings) {
      const rule = cleanRule(finding.rule || finding.detail);
      if (!rule) continue;
      const signature = itemSignature(rule);
      if (!signature) continue;
      // A finding can only be evidence for one item; with several domains the first domain's item
      // holds the link and the others are created alongside so each domain's list can grow.
      let linked = null;
      for (const domain of domains) {
        const item = this._upsertChecklistCandidate({
          scope: "shared", projectId: null, domain, section: cleanSection(finding.section), rule, signature,
        });
        linked ||= item;
        touched.add(item.id);
      }
      this.db.prepare("UPDATE assignment_findings SET checklist_item_id = ? WHERE id = ?").run(linked.id, finding.id);
    }
    // Evidence is linked to the first domain's item; sibling items in other domains read the same
    // evidence through their shared signature, so evaluate every touched item after linking.
    return [...touched].map((itemId) => this._evaluateChecklistPromotion(itemId));
  },

  _upsertChecklistCandidate({ scope, projectId, domain, section, rule, signature }) {
    const existing = this.db.prepare(`
      SELECT * FROM checklist_items
      WHERE scope = ? AND COALESCE(project_id, '') = COALESCE(?, '') AND domain = ? AND signature = ?
    `).get(scope, projectId, domain, signature);
    if (existing) return this._resolveMerged(existing);
    const stamp = now();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO checklist_items (id, scope, project_id, domain, section, rule, signature, status, created_at, updated_at, status_changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?)
    `).run(id, scope, projectId, domain, section, rule, signature, stamp, stamp, stamp);
    return this.db.prepare("SELECT * FROM checklist_items WHERE id = ?").get(id);
  },

  _resolveMerged(item) {
    let current = item;
    for (let hops = 0; current?.status === "merged" && current.merged_into && hops < 20; hops += 1) {
      current = this.db.prepare("SELECT * FROM checklist_items WHERE id = ?").get(current.merged_into);
    }
    return current || item;
  },

  // The findings that are evidence for an item: those linked to it or to anything merged into it,
  // plus — for shared items — findings linked to the same signature in a sibling domain.
  _checklistEvidence(itemId) {
    return this.db.prepare(`
      WITH RECURSIVE family(id) AS (
        SELECT id FROM checklist_items WHERE id = ?
        UNION SELECT c.id FROM checklist_items c JOIN family f ON c.merged_into = f.id
      ),
      siblings(id) AS (
        SELECT s.id FROM checklist_items s JOIN checklist_items me ON me.id = ?
        WHERE s.scope = me.scope AND COALESCE(s.project_id, '') = COALESCE(me.project_id, '') AND s.signature = me.signature
      )
      SELECT f.id, f.task_id, f.assignment_id, COALESCE(f.requested_by_agent_id, 'name:' || f.requested_by_name) AS checker, f.created_at
      FROM assignment_findings f
      WHERE f.checklist_item_id IN (SELECT id FROM family UNION SELECT id FROM siblings)
      ORDER BY f.created_at ASC
    `).all(itemId, itemId);
  },

  _setChecklistStatus(item, status, fields = {}) {
    if (item.status !== status && !TRANSITIONS[item.status]?.includes(status)) {
      throw new Error(`A ${item.status} checklist item cannot become ${status}.`);
    }
    const stamp = now();
    const assignments = Object.entries(fields);
    this.db.prepare(`
      UPDATE checklist_items SET status = ?, updated_at = ?, status_changed_at = ?${assignments.map(([column]) => `, ${column} = ?`).join("")}
      WHERE id = ?
    `).run(status, stamp, item.status === status ? item.status_changed_at : stamp, ...assignments.map(([, value]) => value), item.id);
    return this.db.prepare("SELECT * FROM checklist_items WHERE id = ?").get(item.id);
  },

  // Recurrence on distinct tasks, or two different checkers on the same task. A single finding, the
  // same task twice, or the same checker twice never promotes. An expired item that is raised again
  // comes straight back with all its old evidence. Rejected and merged items are left alone.
  _evaluateChecklistPromotion(itemId) {
    const item = this._resolveMerged(this.db.prepare("SELECT * FROM checklist_items WHERE id = ?").get(itemId));
    if (!item) return null;
    const evidence = this._checklistEvidence(item.id);
    if (item.status === "expired" && evidence.some((row) => row.created_at > item.status_changed_at)) {
      return this._setChecklistStatus(item, "active", { promoted_by: "reactivated", expired_reason: null, expiry_pending_at: null, last_violated_at: now() });
    }
    if (item.status !== "candidate") return item;
    const distinctTasks = new Set(evidence.map((row) => row.task_id)).size;
    if (distinctTasks >= CHECKLIST_RECURRENCE_TASKS) return this._setChecklistStatus(item, "active", { promoted_by: "recurrence" });
    const checkersByTask = new Map();
    for (const row of evidence) {
      if (!checkersByTask.has(row.task_id)) checkersByTask.set(row.task_id, new Set());
      checkersByTask.get(row.task_id).add(row.checker);
    }
    if ([...checkersByTask.values()].some((checkers) => checkers.size >= CHECKLIST_CROSS_CHECKERS)) {
      return this._setChecklistStatus(item, "active", { promoted_by: "cross-validation" });
    }
    return item;
  },

  checklistItem(itemId) {
    const item = this.db.prepare("SELECT * FROM checklist_items WHERE id = ?").get(itemId);
    if (!item) throw new Error("Checklist item not found.");
    const evidence = this._checklistEvidence(item.id);
    return { ...item, pinned: Boolean(item.pinned), confirmations: evidence.length, distinctTasks: new Set(evidence.map((row) => row.task_id)).size };
  },

  listChecklistItems({ domain = null, status = null, projectId = null } = {}) {
    const rows = this.db.prepare(`
      SELECT id FROM checklist_items
      WHERE (? IS NULL OR domain = ?) AND (? IS NULL OR status = ?)
        AND (scope = 'shared' OR (? IS NOT NULL AND project_id = ?))
      ORDER BY domain, section, created_at
    `).all(domain, domain, status, status, projectId, projectId);
    return rows.map((row) => this.checklistItem(row.id));
  },

  // ---- Owner actions -------------------------------------------------------------------------

  approveChecklistItem(itemId) {
    return this._ownerChecklistChange(itemId, (item) => this._setChecklistStatus(item, "active", { promoted_by: "owner" }));
  },

  rejectChecklistItem(itemId) {
    return this._ownerChecklistChange(itemId, (item) => this._setChecklistStatus(item, "rejected"));
  },

  pinChecklistItem(itemId, pinned = true) {
    return this._ownerChecklistChange(itemId, (item) => {
      this.db.prepare("UPDATE checklist_items SET pinned = ?, expiry_pending_at = CASE WHEN ? THEN NULL ELSE expiry_pending_at END, updated_at = ? WHERE id = ?")
        .run(pinned ? 1 : 0, pinned ? 1 : 0, now(), item.id);
      return item;
    });
  },

  // Retire an item by hand, or confirm a learned expiry the sweep proposed.
  retireChecklistItem(itemId, reason = "retired by owner") {
    return this._ownerChecklistChange(itemId, (item) => this._setChecklistStatus(item, "expired", {
      expired_reason: String(reason).slice(0, 200), expiry_pending_at: null,
    }));
  },

  dismissChecklistExpiry(itemId) {
    return this._ownerChecklistChange(itemId, (item) => {
      this.db.prepare("UPDATE checklist_items SET expiry_pending_at = NULL, updated_at = ? WHERE id = ?").run(now(), item.id);
      return item;
    });
  },

  // Fold a near-duplicate into an existing item. Its evidence then counts toward the target, and a
  // later finding matching the duplicate's signature lands on the target too.
  mergeChecklistItem(itemId, intoItemId) {
    return this._ownerChecklistChange(itemId, (item) => {
      const target = this._resolveMerged(this.db.prepare("SELECT * FROM checklist_items WHERE id = ?").get(intoItemId));
      if (!target || target.id === item.id) throw new Error("Merge target must be a different checklist item.");
      if (target.scope !== item.scope || (target.project_id || null) !== (item.project_id || null) || target.domain !== item.domain) {
        throw new Error("Only items in the same scope, project and domain can be merged.");
      }
      this._setChecklistStatus(item, "merged", { merged_into: target.id });
      return this._evaluateChecklistPromotion(target.id);
    });
  },

  // Move an item between the shared domain list and one project's list. Project wording must never
  // leak into shared lists, so this is an owner decision rather than something capture guesses.
  moveChecklistItem(itemId, { scope, projectId = null }) {
    if (!["shared", "project"].includes(scope)) throw new Error("scope must be shared or project.");
    if (scope === "project" && !projectId) throw new Error("A project item needs a projectId.");
    return this._ownerChecklistChange(itemId, (item) => {
      const clash = this.db.prepare(`
        SELECT id FROM checklist_items WHERE scope = ? AND COALESCE(project_id, '') = COALESCE(?, '') AND domain = ? AND signature = ? AND id <> ?
      `).get(scope, scope === "project" ? projectId : null, item.domain, item.signature, item.id);
      if (clash) throw new Error("An item with the same rule already exists there; merge instead.");
      this.db.prepare("UPDATE checklist_items SET scope = ?, project_id = ?, updated_at = ? WHERE id = ?")
        .run(scope, scope === "project" ? projectId : null, now(), item.id);
      return item;
    });
  },

  _ownerChecklistChange(itemId, change) {
    const item = this.db.prepare("SELECT * FROM checklist_items WHERE id = ?").get(itemId);
    if (!item) throw new Error("Checklist item not found.");
    let result;
    this._transaction(() => { result = change(item); });
    this._changed("checklist.updated");
    // A merge answers with the item the evidence now lives on, not the one folded away.
    return this.checklistItem(result?.id || itemId);
  },

  // ---- Delivery hooks and expiry -------------------------------------------------------------

  _recordChecklistDelivery(itemId, assignmentId, deliveredAt = now()) {
    this.db.prepare("INSERT OR IGNORE INTO checklist_deliveries (item_id, assignment_id, delivered_at) VALUES (?, ?, ?)")
      .run(itemId, assignmentId, deliveredAt);
  },

  // A checker's verdict on a delivered item. `violated` is the mistake happening again: it cancels
  // any pending learned-expiry and brings an expired item straight back.
  markChecklistItem({ itemId, assignmentId, mark, agentId = null }) {
    if (!["checked", "violated", "not-applicable"].includes(mark)) throw new Error("mark must be checked, violated or not-applicable.");
    const delivery = this.db.prepare("SELECT 1 FROM checklist_deliveries WHERE item_id = ? AND assignment_id = ?").get(itemId, assignmentId);
    if (!delivery) throw new Error("That checklist item was not delivered to this assignment.");
    const stamp = now();
    this._transaction(() => {
      this.db.prepare("UPDATE checklist_deliveries SET mark = ?, marked_by_agent_id = ?, marked_at = ? WHERE item_id = ? AND assignment_id = ?")
        .run(mark, agentId, stamp, itemId, assignmentId);
      if (mark === "violated") {
        const item = this.db.prepare("SELECT * FROM checklist_items WHERE id = ?").get(itemId);
        if (item.status === "expired") {
          this._setChecklistStatus(item, "active", { promoted_by: "reactivated", expired_reason: null, expiry_pending_at: null, last_violated_at: stamp });
        } else {
          this.db.prepare("UPDATE checklist_items SET last_violated_at = ?, expiry_pending_at = NULL, updated_at = ? WHERE id = ?").run(stamp, stamp, itemId);
        }
      }
    });
    return this.checklistItem(itemId);
  },

  // Sweep active items. Not-applicable expiry is applied; learned expiry is queued for the owner.
  // Pinned items are never touched. Returns what changed so a caller can report it.
  evaluateChecklistExpiry({ at = new Date() } = {}) {
    const atIso = at.toISOString();
    const quietSince = new Date(at.getTime() - CHECKLIST_LEARNED_QUIET_DAYS * 86_400_000).toISOString();
    const expired = [];
    const pending = [];
    this._transaction(() => {
      for (const item of this.db.prepare("SELECT * FROM checklist_items WHERE status = 'active' AND pinned = 0").all()) {
        const recent = this.db.prepare(`
          SELECT mark FROM checklist_deliveries WHERE item_id = ? AND mark IS NOT NULL
          ORDER BY marked_at DESC LIMIT ?
        `).all(item.id, CHECKLIST_NA_WINDOW);
        const notApplicable = recent.filter((row) => row.mark === "not-applicable").length;
        if (recent.length >= CHECKLIST_NA_WINDOW && notApplicable / recent.length >= CHECKLIST_NA_RATIO) {
          this._setChecklistStatus(item, "expired", { expired_reason: "not-applicable", expiry_pending_at: null });
          expired.push(item.id);
          continue;
        }
        if (item.expiry_pending_at) continue;
        const deliveries = this.db.prepare("SELECT COUNT(*) AS n FROM checklist_deliveries WHERE item_id = ?").get(item.id).n;
        const violatedRecently = this.db.prepare(`
          SELECT 1 FROM checklist_deliveries WHERE item_id = ? AND mark = 'violated' AND marked_at >= ? LIMIT 1
        `).get(item.id, quietSince);
        const quiet = !violatedRecently && (!item.last_violated_at || item.last_violated_at < quietSince);
        if (deliveries >= CHECKLIST_LEARNED_DELIVERIES && quiet) {
          this.db.prepare("UPDATE checklist_items SET expiry_pending_at = ?, updated_at = ? WHERE id = ?").run(atIso, atIso, item.id);
          pending.push(item.id);
        }
      }
    });
    if (expired.length || pending.length) this._changed("checklist.updated");
    return { expired, pendingOwnerConfirmation: pending };
  },
};
