/**
 * Agamen bench harness — docs/evaluation.md tiers 1-2.
 *
 * Protocol (charter §3, hardened per internal re-audit A9):
 * - Every variant is measured REPS times; rep 1 is discarded as warmup.
 * - Reps are ROUND-ROBIN INTERLEAVED across variants (one rep per variant
 *   per round), and every odd round runs the variant order reversed. A/B
 *   comparisons are therefore paired at the replicate level: delta_i is
 *   formed from observations taken in the SAME round, adjacent in time —
 *   not from whole-variant blocks that drift apart.
 * - Headline totals are the ARITHMETIC MEAN of measured reps (the charter's
 *   aggregation); median/min/max are reported as dispersion, never as the
 *   headline, and no "best-of-passes" selection is applied.
 * - The no-journal side is the explicitly non-conforming `bench: true` sink
 *   (constant-time hashing, events still generated; rt.conforming === false).
 *
 * v1.6 wiring: bench code is trusted-plane host code — it wires actors via
 * control handles and reaches mailboxes only through attenuated mailbox
 * capabilities (tell consumes the cap, not the receiver's handle).
 *
 * Run: node bench/run.mjs          (markdown to stdout)
 *      node bench/run.mjs json     (machine-readable)
 */

import os from "node:os";
import { Runtime, policy } from "../src/runtime.js";

const WARMUP = 1;
const REPS = WARMUP + 10; // charter: >= 10 measured reps after warmup
const N = 5000; // mediated calls per rep
const args = Object.freeze({ q: "bench" });
const noop = policy(() => true);

/* one rep: build a fresh runtime, run n mediated ops, return ns/op */
async function rep(fn, n = N, opsPerIter = 1) {
  const t0 = performance.now();
  await fn(n);
  return ((performance.now() - t0) * 1e6) / (n * opsPerIter);
}

function stats(samples) {
  const s = [...samples.slice(WARMUP)].sort((a, b) => a - b);
  const mean = s.reduce((x, y) => x + y, 0) / s.length;
  return {
    mean: +mean.toFixed(1),
    median: +s[s.length >> 1].toFixed(1),
    min: +s[0].toFixed(1),
    max: +s[s.length - 1].toFixed(1),
    raw: samples.map((x) => +x.toFixed(1)),
  };
}

/* paired stats over per-round deltas A_i - B_i (same round = the pair) */
function paired(aSamples, bSamples) {
  const d = aSamples.slice(WARMUP).map((x, i) => x - bSamples.slice(WARMUP)[i]).sort((p, q) => p - q);
  const mean = d.reduce((x, y) => x + y, 0) / d.length;
  const bMean = bSamples.slice(WARMUP).reduce((x, y) => x + y, 0) / d.length;
  const aMean = aSamples.slice(WARMUP).reduce((x, y) => x + y, 0) / d.length;
  return {
    deltaMean: +mean.toFixed(1),
    deltaMedian: +d[d.length >> 1].toFixed(1),
    speedup: +(aMean / bMean).toFixed(2), // journal cost multiplier vs bench sink
  };
}

function makeRt({ journal = true, membranes = [] } = {}) {
  const rt = new Runtime({ bench: !journal });
  const { server } = rt.serve("svc", "t", async () => "ok");
  const client = rt.spawn("client");
  rt.grant(server, "t", client, "t", { rights: ["send"], membranes });
  return { rt, client };
}

const invokeLoop = (rt, client) => async (n) => {
  for (let i = 0; i < n; i++) await rt.invoke(client, "t", args);
};

/* ---- tier 1: cost-model coefficients ----
 * Each variant is a FACTORY: called once per rep, it sets up and returns
 * the single-rep measurement. */

const tier1 = {
  // unmediated async call: the honest zero line
  raw: () => {
    const h = async () => "ok";
    return rep(async (n) => {
      for (let i = 0; i < n; i++) await h(args);
    });
  },
  cap_journal: () => {
    const { rt, client } = makeRt();
    return rep(invokeLoop(rt, client));
  },
  cap_bench: () => {
    const { rt, client } = makeRt({ journal: false });
    return rep(invokeLoop(rt, client));
  },
  journal_m1: () => {
    const { rt, client } = makeRt({ membranes: [noop] });
    return rep(invokeLoop(rt, client));
  },
  journal_m3: () => {
    const { rt, client } = makeRt({ membranes: [noop, noop, noop] });
    return rep(invokeLoop(rt, client));
  },
  // tell+recv roundtrip: c_ipc. Messaging is mediated (#3): the sender
  // presents an attenuated mailbox capability, not the receiver's handle.
  ipc: () => {
    const { rt, client } = makeRt();
    const b = rt.spawn("b", { mailbox: N + 8 });
    const cap = rt.grantCap(rt.address(b), client, "mb", { rights: ["send"] });
    return rep(async (n) => {
      for (let i = 0; i < n; i++) {
        rt.tell(client, cap, args);
        rt.recv(b);
      }
    });
  },
  // capability derivation (grant): c_derive
  derive: () => {
    const rt = new Runtime();
    const { server } = rt.serve("svc", "t", async () => "ok");
    const hop = rt.spawn("hop");
    rt.grant(server, "t", hop, "t", { rights: ["send", "grant"] });
    return rep(async (n) => {
      for (let i = 0; i < n; i++) {
        const leaf = rt.spawn("l");
        rt.grant(hop, "t", leaf, "t", { rights: ["send"] });
      }
    });
  },
};

/* ---- tier 2: whole-workload shapes ---- */

const toolLoop = (journal) => () => {
  const { rt, client } = makeRt({ journal, membranes: [noop] });
  return rep(invokeLoop(rt, client));
};

const tier2 = {
  tool_loop_journal: toolLoop(true),
  tool_loop_bench: toolLoop(false),
  // fan-out: planner mails 8 workers, each replies. One cycle moves
  // 16 messages = 32 queue operations; reported PER QUEUE OP (F18:
  // per-message cost is 2x this figure).
  fanout: () => {
    const { rt } = makeRt({ journal: false });
    const planner = rt.spawn("planner");
    const workers = Array.from({ length: 8 }, (_, i) => rt.spawn(`w${i}`));
    const toPlanner = workers.map((w, i) =>
      rt.grantCap(rt.address(planner), w, "p", { rights: ["send"] }));
    const toWorker = workers.map((w, i) =>
      rt.grantCap(rt.address(w), planner, `w${i}`, { rights: ["send"] }));
    return rep(async (n) => {
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 8; k++) rt.tell(planner, toWorker[k], args);
        for (let k = 0; k < 8; k++) {
          rt.recv(workers[k]);
          rt.tell(workers[k], toPlanner[k], args);
        }
        for (let k = 0; k < 8; k++) rt.recv(planner);
      }
    }, N, 32);
  },
  // delegation chain: depth-4 grant then one invoke at the leaf
  chain4: () => {
    const rt = new Runtime();
    const { server } = rt.serve("svc", "t", async () => "ok");
    return rep(async (n) => {
      for (let i = 0; i < n; i++) {
        const h1 = rt.spawn("h1"), h2 = rt.spawn("h2"), h3 = rt.spawn("h3"), h4 = rt.spawn("h4");
        rt.grant(server, "t", h1, "t", { rights: ["send", "grant"] });
        rt.grant(h1, "t", h2, "t", { rights: ["send", "grant"] });
        rt.grant(h2, "t", h3, "t", { rights: ["send", "grant"] });
        rt.grant(h3, "t", h4, "t", { rights: ["send"] });
        await rt.invoke(h4, "t", args);
      }
    });
  },
};

const PAIRS = [
  ["cap_journal", "cap_bench"], // c_journal coefficient
  ["tool_loop_journal", "tool_loop_bench"], // whole-workload audit share
];

/* ---- memory: journal bytes retained per mediated call ---- */

function deepSize(v, seen = new Set()) {
  if (v === null || typeof v !== "object") {
    if (typeof v === "string") return 2 * v.length + 16;
    return typeof v === "number" || typeof v === "boolean" ? 8 : 0;
  }
  if (seen.has(v)) return 0;
  seen.add(v);
  let s = 64; // object header/slots estimate
  if (Array.isArray(v)) for (const x of v) s += deepSize(x, seen);
  else for (const k of Object.keys(v)) s += 2 * k.length + 8 + deepSize(v[k], seen);
  return s;
}

async function memCost() {
  const { rt, client } = makeRt();
  const before = deepSize(rt.journalEntries());
  for (let i = 0; i < N; i++) await rt.invoke(client, "t", args);
  const after = deepSize(rt.journalEntries());
  return { bytesPerCall: +((after - before) / N).toFixed(1), entries: rt.journalEntries().length };
}

export async function run(which = "all") {
  const variants = { ...tier1, ...tier2 };
  const names =
    which === "1" ? Object.keys(tier1)
      : which === "2" ? Object.keys(tier2)
      : which === "all" ? Object.keys(variants)
      : which.split(",").filter((k) => k in variants);
  const perRep = Object.fromEntries(names.map((k) => [k, []]));
  for (let r = 0; r < REPS; r++) {
    const seq = r % 2 === 0 ? names : [...names].reverse(); // drift control
    for (const name of seq) {
      perRep[name].push(await variants[name]()); // fresh runtime per rep
    }
  }
  const statsByVariant = Object.fromEntries(names.map((k) => [k, stats(perRep[k])]));
  const pairedByGroup = {};
  for (const [a, b] of PAIRS) {
    if (names.includes(a) && names.includes(b)) pairedByGroup[`${a}~${b}`] = paired(perRep[a], perRep[b]);
  }
  return { roundRobin: statsByVariant, paired: pairedByGroup, memory: await memCost(), perRep };
}

if (globalThis.process?.argv?.[1]?.endsWith("run.mjs")) {
  const groups = await run();
  if (process.argv[2] === "json") {
    console.log(JSON.stringify({ groups, env: envMeta() }, null, 2));
  } else {
    console.log(renderMarkdown(groups, envMeta()));
  }
}

function envMeta() {
  const p = globalThis.process;
  return {
    date: new Date().toISOString().slice(0, 10),
    node: p?.version ?? "(embedded repl)",
    os: p ? `${p.platform} ${os.release()}` : "?",
    cpu: os.cpus()[0].model.trim(),
    logicalCpus: os.cpus().length,
    warmupReps: WARMUP,
    measuredReps: REPS - WARMUP,
    n: N,
    protocol: `round-robin interleaved, ${REPS} reps, fresh runtime per rep, odd rounds reversed`,
  };
}

function renderMarkdown(groups, env) {
  let md = `| variant | mean ns | median ns | min ns | max ns |\n|---|---|---|---|---|\n`;
  for (const [name, s] of Object.entries(groups.roundRobin)) {
    md += `| ${name} | ${s.mean} | ${s.median} | ${s.min} | ${s.max} |\n`;
  }
  md += `\npaired (same-round deltas):\n\n`;
  md += `| pair | Δmean ns | Δmedian ns | journal/nojournal ratio |\n|---|---|---|---|\n`;
  for (const [k, p] of Object.entries(groups.paired)) {
    md += `| ${k} | ${p.deltaMean} | ${p.deltaMedian} | ${p.speedup}× |\n`;
  }
  if (groups.memory) md += `\njournal memory: ~${groups.memory.bytesPerCall} B retained per mediated invoke\n`;
  return md + `\nenv: ${JSON.stringify(env)}\n`;
}
