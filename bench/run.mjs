/**
 * Agamen bench harness — docs/evaluation.md tiers 1-2.
 *
 * Tier 1 fits the per-invoke cost model coefficients (c_cap, c_journal,
 * c_mem, c_ipc); tier 2 runs whole agent-workload shapes. Aggregation per
 * charter §3: 11 reps per variant, rep 1 discarded as warmup, 10 measured
 * reps; totals (ns/call) use the arithmetic mean, medians are reported for
 * spread; every journal-vs-nojournal comparison is PAIRED (identical
 * workloads, differing only in the audit sink) and variants are interleaved
 * to fight drift. Memory cost is reported as journal bytes retained per
 * mediated call (deep-size estimate, not process RSS).
 *
 * The no-journal side is the explicitly non-conforming `bench: true` sink
 * (constant-time hashing, events still generated): rt.conforming === false.
 * There is no journal:false seam anymore (review F7).
 *
 * Run: node bench/run.mjs          (markdown to stdout)
 *      node bench/run.mjs json     (machine-readable)
 */

import os from "node:os";
import { Runtime, policy } from "../src/runtime.js";

const WARMUP = 1;
const REPS = WARMUP + 10; // charter: >= 10 measured reps after warmup
const N = 5000; // mediated calls per run
const args = Object.freeze({ q: "bench" });
const noop = policy(() => true);

function stats(samples) {
  const s = [...samples.slice(WARMUP)].sort((a, b) => a - b); // drop warmup rep(s)
  const mean = s.reduce((x, y) => x + y, 0) / s.length;
  return {
    mean: +mean.toFixed(1),
    median: +s[s.length >> 1].toFixed(1),
    min: +s[0].toFixed(1),
    max: +s[s.length - 1].toFixed(1),
    raw: samples.map((x) => +x.toFixed(1)),
  };
}

async function timed(fn, opsPerIter = 1, n = N) {
  const out = [];
  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    await fn(n);
    const dt = performance.now() - t0;
    out.push((dt * 1e6) / (n * opsPerIter)); // ns per op
  }
  return stats(out);
}

function makeRt({ journal = true, membranes = [] } = {}) {
  const rt = new Runtime({ bench: !journal });
  const { server } = rt.serve("svc", "t", async () => "ok");
  const client = rt.spawn("client");
  rt.grant(server, "t", client, "t", { rights: ["send"], membranes });
  return { rt, client };
}

const loop = (rt, client, n) => async () => {
  for (let i = 0; i < n; i++) await rt.invoke(client, "t", args);
};

/* ---- tier 1: cost-model coefficients ---- */

const tier1 = {
  // unmediated async call: the honest zero line
  raw: () =>
    timed(async (n) => {
      const h = async () => "ok";
      for (let i = 0; i < n; i++) await h(args);
    }),
  cap_journal: () => {
    const { rt, client } = makeRt();
    return timed(loop(rt, client, N));
  },
  cap_bench: () => {
    const { rt, client } = makeRt({ journal: false });
    return timed(loop(rt, client, N));
  },
  journal_m1: () => {
    const { rt, client } = makeRt({ membranes: [noop] });
    return timed(loop(rt, client, N));
  },
  journal_m3: () => {
    const { rt, client } = makeRt({ membranes: [noop, noop, noop] });
    return timed(loop(rt, client, N));
  },
  // tell+recv roundtrip: c_ipc. Messaging is mediated (F1a): the sender
  // needs an attenuated mailbox capability for the target.
  ipc: () => {
    const { rt, client } = makeRt();
    const b = rt.spawn("b", { mailbox: N + 8 });
    rt.grantCap(rt.address(b), client, "mb", { rights: ["send"] });
    return timed((n) => (async () => {
      for (let i = 0; i < n; i++) {
        rt.tell(client, b, args);
        rt.recv(b);
      }
    })());
  },
  // capability derivation (grant): c_derive
  derive: () => {
    const rt = new Runtime();
    const { server } = rt.serve("svc", "t", async () => "ok");
    const hop = rt.spawn("hop");
    rt.grant(server, "t", hop, "t", { rights: ["send", "grant"] });
    return timed((n) => (async () => {
      for (let i = 0; i < n; i++) {
        const leaf = rt.spawn("l");
        rt.grant(hop, "t", leaf, "t", { rights: ["send"] });
      }
    })());
  },
};

/* ---- tier 2: whole-workload shapes ---- */

const toolLoop = (journal) => () => {
  const { rt, client } = makeRt({ journal, membranes: [noop] });
  return timed(loop(rt, client, N));
};

const tier2 = {
  // paired tool loops: identical workload, only the audit sink differs
  tool_loop_journal: toolLoop(true),
  tool_loop_bench: toolLoop(false),
  // fan-out: planner mails 8 workers, each replies. One cycle moves
  // 16 messages = 32 queue operations; reported PER QUEUE OP (F18:
  // per-message cost is 2x this figure).
  fanout: () => {
    const { rt, client } = makeRt({ journal: false });
    const planner = rt.spawn("planner");
    const workers = Array.from({ length: 8 }, (_, i) => rt.spawn(`w${i}`));
    const addr = rt.address(planner);
    workers.forEach((w, i) => {
      rt.grantCap(addr, w, "p", { rights: ["send"] }); // worker -> planner
      rt.grantCap(rt.address(w), planner, `w${i}`, { rights: ["send"] }); // planner -> worker (distinct slot per target)
    });
    void client;
    return timed((n) => (async () => {
      for (let i = 0; i < n; i++) {
        for (const w of workers) rt.tell(planner, w, args);
        for (const w of workers) {
          rt.recv(w);
          rt.tell(w, planner, args);
        }
        for (const _ of workers) rt.recv(planner);
      }
    })(), 32);
  },
  // delegation chain: depth-4 grant then one invoke at the leaf
  chain4: () => {
    const rt = new Runtime();
    const { server } = rt.serve("svc", "t", async () => "ok");
    return timed((n) => (async () => {
      for (let i = 0; i < n; i++) {
        const h1 = rt.spawn("h1"), h2 = rt.spawn("h2"), h3 = rt.spawn("h3"), h4 = rt.spawn("h4");
        rt.grant(server, "t", h1, "t", { rights: ["send", "grant"] });
        rt.grant(h1, "t", h2, "t", { rights: ["send", "grant"] });
        rt.grant(h2, "t", h3, "t", { rights: ["send", "grant"] });
        rt.grant(h3, "t", h4, "t", { rights: ["send"] });
        await rt.invoke(h4, "t", args);
      }
    })());
  },
};

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
  const before = deepSize(rt.journal.entries);
  for (let i = 0; i < N; i++) await rt.invoke(client, "t", args);
  const after = deepSize(rt.journal.entries);
  return { bytesPerCall: +((after - before) / N).toFixed(1), entries: rt.journal.entries.length };
}

export async function run(which = "all") {
  const groups = {};
  if (which === "all" || which === "1" || which === "2") {
    const variants = { ...tier1, ...tier2 };
    const names =
      which === "1" ? Object.keys(tier1) : which === "2" ? Object.keys(tier2) : Object.keys(variants);
    // interleave two passes so paired variants also swap order (drift control)
    const order = names.concat([...names].reverse());
    groups.paired = {};
    for (const name of order) {
      const s = await variants[name]();
      const prev = groups.paired[name];
      groups.paired[name] = prev
        ? { pass1: prev, pass2: s, best_ns: Math.min(prev.median, s.median) }
        : s;
    }
    groups.memory = await memCost();
  } else {
    const names = which.split(",");
    const pick = (map) =>
      Object.fromEntries(Object.entries(map).filter(([k]) => names.includes(k)));
    groups.selected = await runAll({ ...pick(tier1), ...pick(tier2) });
  }
  return groups;
}

async function runAll(variants) {
  const out = {};
  for (const [name, fn] of Object.entries(variants)) out[name] = await fn();
  return out;
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
  };
}

function renderMarkdown(groups, env) {
  let md = `| variant | mean ns | median ns | min ns | max ns |\n|---|---|---|---|---|\n`;
  for (const [name, s] of Object.entries(groups.paired ?? {})) {
    const rep = s.pass2 ?? s;
    md += `| ${name} | ${rep.mean} | ${rep.median} | ${rep.min} | ${rep.max} |\n`;
  }
  if (groups.memory) md += `\njournal memory: ~${groups.memory.bytesPerCall} B retained per mediated invoke\n`;
  return md + `\nenv: ${JSON.stringify(env)}\n`;
}
