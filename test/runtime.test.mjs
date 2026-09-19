import test from "node:test";
import assert from "node:assert/strict";
import { Runtime, SubstrateError, rateLimit, policy } from "../src/runtime.js";

const code = (fn) => fn().then(() => null, (e) => e.code);

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
