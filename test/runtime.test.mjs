import test from "node:test";
import assert from "node:assert/strict";
import { Runtime, SubstrateError, rateLimit, policy } from "../src/runtime.js";

const code = (fn) => fn().then(() => null, (e) => e.code);

const deferred = () => {
  let resolve, reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
};

test("zero-authority: fresh actor holds nothing", async () => {
  const rt = new Runtime();
  const a = rt.spawn("alice");
  assert.equal(a.slots.size, 0);
  assert.equal(await code(() => rt.invoke(a, "anything", {})), "E_NO_CAP");
});

test("attenuation: derivation may only shrink rights", () => {
  const rt = new Runtime();
  const { server } = rt.serve("svc", "search", async () => "ok");
  const client = rt.spawn("client");
  rt.grant(server, "search", client, "search", { rights: ["send"] });
  assert.equal([...client.hold("search").rights].join(), "send");
  // send-only cap cannot hand out what it never received
  assert.throws(
    () => client.hold("search").attenuate({ rights: ["send", "revoke"] }),
    SubstrateError
  );
  assert.throws(
    () => rt.grant(client, "search", rt.spawn("x"), "s", { rights: ["send", "grant"] }),
    SubstrateError
  );
});

test("revocation cascades to the whole derivation subtree", async () => {
  const rt = new Runtime();
  const { server, cap } = rt.serve("svc", "search", async () => "ok");
  const mid = rt.spawn("mid");
  const leaf = rt.spawn("leaf");
  rt.grant(server, "search", mid, "search", { rights: ["send", "grant"] });
  rt.grant(mid, "search", leaf, "search", { rights: ["send"] });
  rt.revoke(cap);
  assert.equal(leaf.hold("search").revoked, true);
  assert.equal(await code(() => rt.invoke(leaf, "search", {})), "E_REVOKED");
});

test("identity stamping: sender is runtime-bound, not message-borne", () => {
  const rt = new Runtime();
  const a = rt.spawn("a");
  const b = rt.spawn("b");
  rt.tell(a, b, { sender: 999, text: "forged" });
  const m = rt.recv(b);
  assert.equal(m.sender, a.id);
});

test("membrane: budget and policy enforce outside the caller", async () => {
  const rt = new Runtime();
  const { server } = rt.serve("svc", "echo", async (args) => args);
  const client = rt.spawn("client");
  rt.grant(server, "echo", client, "echo", {
    rights: ["send"],
    membranes: [policy((x) => x.q?.length < 10, "query too long"), rateLimit(2)],
  });
  assert.deepEqual(await rt.invoke(client, "echo", { q: "hi" }), { q: "hi" });
  await rt.invoke(client, "echo", { q: "hi" });
  assert.equal(await code(() => rt.invoke(client, "echo", { q: "hi" })), "E_BUDGET");
  assert.equal(await code(() => rt.invoke(client, "echo", { q: "x".repeat(20) })), "E_POLICY");
});

test("provenance: quad recorded per invoke; chain tamper-evident", async () => {
  const rt = new Runtime();
  const { server } = rt.serve("svc", "add", async ({ a, b }) => a + b);
  const client = rt.spawn("client");
  rt.grant(server, "add", client, "add", { rights: ["send"] });
  assert.equal(await rt.invoke(client, "add", { a: 2, b: 3 }), 5);
  const inv = rt.journal.entries.filter((e) => e.event.t === "invoke");
  assert.equal(inv.length, 1);
  for (const k of ["actor", "tool", "xact", "argsHash", "resultHash"]) {
    assert.ok(inv[0].event[k], `provenance quad carries ${k}`);
  }
  assert.ok(rt.journal.verify());
  rt.journal.entries[inv[0].seq].event.tool = "tampered";
  assert.equal(rt.journal.verify(), false);
});

test("multi-actor flow: grant chain + tell/reply + journal", async () => {
  const rt = new Runtime();
  const { server } = rt.serve("tool", "lookup", async ({ key }) => ({ key, val: 42 }));
  const planner = rt.spawn("planner");
  const worker = rt.spawn("worker");
  rt.grant(server, "lookup", planner, "lookup", { rights: ["send", "grant"] });
  rt.grant(planner, "lookup", worker, "lookup", {
    rights: ["send"],
    membranes: [rateLimit(1)],
  });
  const result = await rt.invoke(worker, "lookup", { key: "x" });
  rt.tell(worker, planner, { done: result });
  const seen = rt.recv(planner);
  assert.equal(seen.sender, worker.id);
  assert.ok(rt.journal.verify());
});

/* ===================== M1 — scheduling semantics ===================== */

test("deadline: expired request is denied before the handler runs", async () => {
  let t = 0;
  const rt = new Runtime({ now: () => t });
  let ran = false;
  const { server } = rt.serve("svc", "slow", async () => { ran = true; return 1; });
  const client = rt.spawn("client");
  rt.grant(server, "slow", client, "slow", { rights: ["send"] });
  t = 100;
  assert.equal(await code(() => rt.invoke(client, "slow", {}, { deadline: 50 })), "E_DEADLINE");
  assert.equal(ran, false, "a request past its deadline must not execute server-side");
  const den = rt.journal.entries.at(-1).event;
  assert.equal(den.t, "invoke_denied");
  assert.equal(den.code, "E_DEADLINE");
});

test("deadline: late completion is not delivered; outcome journaled timeout", async () => {
  let t = 0;
  const rt = new Runtime({ now: () => t });
  const d = deferred();
  const { server } = rt.serve("svc", "work", () => d.p);
  const client = rt.spawn("client");
  rt.grant(server, "work", client, "work", { rights: ["send"] });
  const pr = rt.invoke(client, "work", {}, { deadline: 50 });
  t = 100;
  d.resolve("late");
  assert.equal(await code(() => pr), "E_TIMEOUT");
  const ev = rt.journal.entries.at(-1).event;
  assert.equal(ev.t, "invoke");
  assert.equal(ev.outcome, "timeout");
  assert.ok(!("resultHash" in ev), "a timed-out result is never journaled as delivered");
});

test("cancel: by xact id discards a pending result", async () => {
  const rt = new Runtime();
  const d = deferred();
  const { server } = rt.serve("svc", "work", () => d.p);
  const client = rt.spawn("client");
  rt.grant(server, "work", client, "work", { rights: ["send"] });
  const { xact, promise } = rt.request(client, "work", {});
  assert.equal(rt.cancel(xact), true);
  d.resolve("stale");
  assert.equal(await code(() => promise), "E_CANCELLED");
  const ev = rt.journal.entries.at(-1).event;
  assert.equal(ev.t, "invoke");
  assert.equal(ev.outcome, "cancelled");
});

test("cancel: aborted signal blocks admission; handler never runs", async () => {
  const rt = new Runtime();
  let ran = false;
  const { server } = rt.serve("svc", "never", async () => { ran = true; });
  const client = rt.spawn("client");
  rt.grant(server, "never", client, "never", { rights: ["send"] });
  const ac = new AbortController();
  ac.abort();
  assert.equal(await code(() => rt.invoke(client, "never", {}, { signal: ac.signal })), "E_CANCELLED");
  assert.equal(ran, false);
});

test("lifecycle: queued messages expire at delivery and cancel by xact", () => {
  let t = 0;
  const rt = new Runtime({ now: () => t });
  const a = rt.spawn("a");
  const b = rt.spawn("b");
  rt.tell(a, b, { n: 1 }, { deadline: 50 });
  rt.tell(a, b, { n: 2 }, { xact: "job42" });
  t = 100;
  assert.equal(rt.cancel("job42"), true);
  assert.equal(rt.recv(b), null, "expired and cancelled messages are both undeliverable");
  const types = rt.journal.entries.map((e) => e.event.t);
  assert.ok(types.includes("expire") && types.includes("cancel"));
});

test("backpressure: a saturated mailbox sheds explicitly", () => {
  const rt = new Runtime();
  const a = rt.spawn("a");
  const b = rt.spawn("b", { mailbox: 1 });
  assert.equal(rt.tell(a, b, { n: 1 }), true);
  assert.throws(
    () => rt.tell(a, b, { n: 2 }),
    (e) => e instanceof SubstrateError && e.code === "E_SHED"
  );
  assert.equal(rt.journal.entries.at(-1).event.t, "shed");
  assert.equal(rt.recv(b).msg.n, 1);
});

test("backpressure: a blocking send completes when recv frees a slot", async () => {
  const rt = new Runtime();
  const a = rt.spawn("a");
  const b = rt.spawn("b", { mailbox: 1, onFull: "block" });
  rt.tell(a, b, { n: 1 });
  const pending = rt.tell(a, b, { n: 2 });
  assert.ok(pending instanceof Promise);
  assert.equal(rt.recv(b).msg.n, 1);
  assert.equal(await pending, true);
  assert.equal(rt.recv(b).msg.n, 2);
});

test("lifecycle: success and failure are distinct journaled outcomes (spec 13 #9)", async () => {
  const rt = new Runtime();
  const { server } = rt.serve("svc", "flip", async ({ mode }) => {
    if (mode === "boom") throw new Error("boom");
    return "v";
  });
  const client = rt.spawn("client");
  rt.grant(server, "flip", client, "flip", { rights: ["send"] });
  assert.equal(await rt.invoke(client, "flip", { mode: "ok" }), "v");
  await assert.rejects(() => rt.invoke(client, "flip", { mode: "boom" }), /boom/);
  const outcomes = rt.journal.entries.filter((e) => e.event.t === "invoke").map((e) => e.event.outcome);
  assert.deepEqual(outcomes, ["ok", "fail"]);
  assert.ok(rt.journal.verify());
});
