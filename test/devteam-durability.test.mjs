import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";

// Durability: one data directory belongs to one process. The `jobs` half of this file went with the
// verified-checks executor — nothing runs off the event loop any more, so no call outlives itself
// and there is no in-flight window to record. Multi-process is deliberately NOT here: nothing has
// hit a measured limit that would justify it.

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-durable-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-durable-project-"));
  const opened = [];
  const open = () => {
    const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
    opened.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of opened) { try { store.close(); } catch { /* already closed */ } }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const store = open();
  const project = store.ensureProject("Durable project", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Durable work", description: "Exercise durability." });
  const agent = store.connectAgent({ name: "Reporter", provider: "fixture", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  return { store, open, dataDir, project, task, agent };
}

function claimWork(store, agent, task, title = "Do the work") {
  store.createAssignment({ taskId: task.id, title, description: "Work.", role: "implementer" });
  return store.claimNextAssignment(agent.id);
}

test("one data directory belongs to one process while that process is live", async (t) => {
  // Two servers on one database would hand out write leases from two schedulers, each reaping the
  // other's agents. The lease model is the thing that must never be loosened for throughput, so
  // this is refused loudly rather than papered over.
  const { store, open, dataDir } = await fixture(t);
  assert.ok(store.instanceId, "a live store identifies itself");
  assert.throws(() => open(), /already using this data directory/i);
  assert.match(String(dataDir), /devteam-durable-data-/);
});

test("closing a store hands its data directory to the next process", async (t) => {
  const { store, open } = await fixture(t);
  store.close();
  const next = open();
  assert.notEqual(next.instanceId, store.instanceId);
});

test("a data directory left locked by a crashed process is taken over once the lock goes stale", async (t) => {
  // The alternative is a server that refuses to start after a hard kill until someone deletes a
  // file by hand, which is how a safety measure becomes the thing people disable.
  const { store, open } = await fixture(t);
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const lock = JSON.parse(store.db.prepare("SELECT value FROM metadata WHERE key = 'server_instance'").get().value);
  store.db.prepare("UPDATE metadata SET value = ? WHERE key = 'server_instance'")
    .run(JSON.stringify({ ...lock, heartbeatAt: stale }));
  // Simulate the process being gone without close() ever running.
  store.db.close();

  const restarted = open();
  assert.ok(restarted.instanceId, "a stale lock is taken over rather than requiring manual cleanup");
  assert.notEqual(restarted.instanceId, store.instanceId);
});

test("a CLI can read the database while the server owns it, without touching scheduling state", async (t) => {
  // `devteam token` is run while the server is up, by definition. Before the lock it opened the
  // database as a second owner and ran orphan recovery and status derivation
  // against a live scheduler — quietly moving work around from a command that only prints a string.
  const { store, dataDir, task, agent } = await fixture(t);
  const claim = claimWork(store, agent, task);
  const before = store.db.prepare("SELECT status, agent_id, claim_generation FROM assignments WHERE id = ?").get(claim.id);

  const observer = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false }, exclusive: false });
  t.after(() => { try { observer.close(); } catch { /* already closed */ } });
  assert.equal(observer.token, store.token, "an observer can read what it came for");
  assert.equal(observer.instanceId, null, "and never claims the directory");

  const after = store.db.prepare("SELECT status, agent_id, claim_generation FROM assignments WHERE id = ?").get(claim.id);
  assert.deepEqual(after, before, "the live claim is exactly as the server left it");
  const lock = JSON.parse(store.db.prepare("SELECT value FROM metadata WHERE key = 'server_instance'").get().value);
  assert.equal(lock.instanceId, store.instanceId, "and the server still owns the lock");
  observer.close();
  const stillLocked = store.db.prepare("SELECT value FROM metadata WHERE key = 'server_instance'").get();
  assert.ok(stillLocked, "an observer closing does not release someone else's lock");
});

test("a lock held by a process that no longer exists is not a lock", async (t) => {
  // A clean shutdown releases the directory, but a SIGKILL cannot. Waiting out the stale window
  // would mean refusing to restart for two minutes after any hard kill, which is how a safety
  // measure teaches people to disable it. The lock guards a local directory, so the pid can be asked
  // directly — and a fresh heartbeat from a dead pid is still a dead process.
  const { store, open } = await fixture(t);
  const lock = JSON.parse(store.db.prepare("SELECT value FROM metadata WHERE key = 'server_instance'").get().value);
  store.db.prepare("UPDATE metadata SET value = ? WHERE key = 'server_instance'").run(JSON.stringify({
    ...lock,
    instanceId: "someone-elses-instance",
    pid: 0x7fffffff, // a pid nothing on this machine is using
    heartbeatAt: new Date().toISOString(),
  }));
  store.db.close();

  const restarted = open();
  assert.ok(restarted.instanceId, "the directory is taken over immediately rather than after a timeout");
});
