/**
 * Agamen bench harness — docs/evaluation.md tiers 1-2.
 *
 * Tier 1 fits the per-invoke cost model coefficients (c_cap, c_journal,
 * c_mem, c_ipc); tier 2 runs whole agent-workload shapes. Aggregation per
 * charter §3: REPS runs per variant, first dropped as warmup, median/max
 * reported; ns/call (a total) uses arithmetic statistics, never a mean of
 * mixed ratios.
 *
 * Run: node bench/run.mjs          (markdown to stdout)
 *      node bench/run.mjs json     (machine-readable)
 */

import os from "node:os";
import { Runtime, policy } from "../src/runtime.js";

const REPS = 10;      // runs per variant (charter: >= 10 after warmup)
const N = 5000;       // mediated calls per run
const args = Object.freeze({ q: "bench" });
const noop = policy(() => true);

function stats(samples) {
  const s = [...samples.slice(1)].sort((a, b) => a - b); // drop warmup rep
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
  const dts = [];
  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    await fn(n);
    const dt = performance.now() - t0;
    dts.push(+dt.toFixed(2));
    out.push((dt * 1e6) / (n * opsPerIter)); // ns per op
  }
  return { ...stats(out), dtMs: dts };
}

function makeRt({ journal = true, membranes = [] } = {}) {
  const rt = new Runtime({ journal });
  const { server } = rt.serve("svc", "t", async () => "ok");
  const client = rt.spawn("client");
  rt.grant(server, "t", client, "t", { rights: ["send"], membranes });
  return { rt, client };
}

/* ---- tier 1: cost-model coefficients ---- */

const tier1 = {
  // unmediated async call: the honest zero line
  raw: () =>
    timed(async (n) => {
      const h = async () => "ok";
      for (let i = 0; i < n; i++) await h(args);
    }),
  cap_nojournal: () => {
    const { rt, client } = makeRt({ journal: false });
    return timed((n) => (async () => { for (let i = 0; i < n; i++) await rt.invoke(client, "t", args); })());
  },
  cap_journal: () => {
    const { rt, client } = makeRt();
    return timed((n) => (async () => { for (let i = 0; i < n; i++) await rt.invoke(client, "t", args); })());
  },
  journal_m1: () => {
    const { rt, client } = makeRt({ membranes: [noop] });
    return timed((n) => (async () => { for (let i = 0; i < n; i++) await rt.invoke(client, "t", args); })());
  },
  journal_m3: () => {
    const { rt, client } = makeRt({ membranes: [noop, noop, noop] });
    return timed((n) => (async () => { for (let i = 0; i < n; i++) await rt.invoke(client, "t", args); })());
  },
  // tell+recv roundtrip: c_ipc
  ipc: () => {
    const { rt } = makeRt();
    const a = rt.spawn("a");
    const b = rt.spawn("b", { mailbox: N + 8 });
    return timed((n) => (async () => {
      for (let i = 0; i < n; i++) { rt.tell(a, b, args); rt.recv(b); }
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

const tier2 = {
  // tool loop: K sequential mediated invokes, one membrane
  tool_loop: () => {
    const { rt, client } = makeRt({ membranes: [noop] });
    return timed((n) => (async () => { for (let i = 0; i < n; i++) await rt.invoke(client, "t", args); })());
  },
  // fan-out: one planner mails 8 workers per cycle, workers reply
  // (reported per message: each cycle moves 32 messages)
  fanout: () => {
    const { rt } = makeRt({ journal: false });
    const planner = rt.spawn("planner");
    const workers = Array.from({ length: 8 }, (_, i) => rt.spawn(`w${i}`));
    return timed((n) => (async () => {
      for (let i = 0; i < n; i++) {
        for (const w of workers) rt.tell(planner, w, args);
        for (const w of workers) { rt.recv(w); rt.tell(w, planner, args); }
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

export async function run(which = "all") {
  const groups = {};
  if (which === "all" || which === "1") groups.tier1 = await runAll(tier1);
  else if (which === "2") groups.tier2 = await runAll(tier2);
  else {
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
    reps: REPS,
    n: N,
  };
}

function renderMarkdown(groups, env) {
  let md = `| variant | mean ns | median ns | max ns |\n|---|---|---|---|\n`;
  for (const [tier, rows] of Object.entries(groups)) {
    md += `| _${tier}_ | | | |\n`;
    for (const [name, s] of Object.entries(rows)) {
      md += `| ${name} | ${s.mean} | ${s.median} | ${s.max} |\n`;
    }
  }
  return md + `\nenv: ${JSON.stringify(env)}\n`;
}
