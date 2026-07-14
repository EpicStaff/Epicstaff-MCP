import { connect, compile, push, run, type RunResult } from './lib.mjs';

type FV = Record<string, any> | null;
interface Case {
  dir: string;
  initialState: Record<string, unknown>;
  llm?: boolean;
  check: (fv: FV, r: RunResult) => string[]; // returns list of failed assertions
}

const B = '_stress/flows';
const cases: Case[] = [
  {
    dir: `${B}/f1-pipeline-nested`,
    initialState: { order: { items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 3 }], customer: { tier: 'gold' } } },
    check: (fv) => {
      const f: string[] = [];
      if (fv?.normalized?.count !== 5) f.push(`normalized.count=${fv?.normalized?.count}!=5`);
      if (fv?.pricing?.total !== 40) f.push(`pricing.total=${fv?.pricing?.total}!=40`);
      if (fv?.summary?.total !== 40) f.push(`summary.total=${fv?.summary?.total}!=40`);
      return f;
    },
  },
  {
    dir: `${B}/f2-decision-table`,
    initialState: { input_value: 80 },
    check: (fv) => {
      const f: string[] = [];
      if (fv?.metrics?.band !== 'high') f.push(`metrics.band=${fv?.metrics?.band}!=high`);
      if (fv?.outcome?.tier !== 'priority') f.push(`outcome.tier=${fv?.outcome?.tier}!=priority`);
      if (fv?.outcome?.value !== 80) f.push(`outcome.value=${fv?.outcome?.value}!=80`);
      return f;
    },
  },
  {
    dir: `${B}/f4-chain-merge`,
    initialState: { seed: 6 },
    check: (fv) => {
      const f: string[] = [];
      if (fv?.left?.double !== 12) f.push(`left.double=${fv?.left?.double}!=12`);
      if (fv?.right?.square !== 36) f.push(`right.square=${fv?.right?.square}!=36`);
      if (fv?.merged?.sum !== 48) f.push(`merged.sum=${fv?.merged?.sum}!=48`);
      return f;
    },
  },
  {
    dir: `${B}/f6-paths`,
    initialState: {},
    check: (fv) => {
      const f: string[] = [];
      if (fv?.pick?.count !== 2) f.push(`pick.count=${fv?.pick?.count}!=2`);
      if (fv?.pick?.first_name !== 'alpha') f.push(`pick.first_name=${fv?.pick?.first_name}!=alpha`);
      if (fv?.second?.label !== 'beta') f.push(`second.label=${fv?.second?.label}!=beta`);
      if (fv?.summary?.total_qty !== 9) f.push(`summary.total_qty=${fv?.summary?.total_qty}!=9`);
      return f;
    },
  },
  {
    dir: `${B}/f5-agent-pipeline`,
    initialState: { request: { text: 'I need 4 wooden chairs please' } },
    llm: true,
    check: (fv) => {
      const f: string[] = [];
      if (fv?.calc?.quantity !== 4) f.push(`calc.quantity=${fv?.calc?.quantity}!=4`);
      if (fv?.calc?.line_total !== 100) f.push(`calc.line_total=${fv?.calc?.line_total}!=100`);
      if (typeof fv?.reply !== 'string' || !fv.reply.trim()) f.push(`reply not a non-empty string`);
      return f;
    },
  },
];

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
const HT = process.env.ES_URL!.replace(/\/+$/, '') + '/ht/';
async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(HT);
      if (r.ok) return;
    } catch {
      /* worker restarting */
    }
    await sleep(2000);
  }
  throw new Error('backend did not become healthy in time');
}

await waitHealthy();
const context = await connect();
const results: { name: string; pass: boolean; detail: string }[] = [];
let streak = 0;
let bestStreak = 0;

async function attempt(c: Case): Promise<{ pass: boolean; detail: string; fv: FV }> {
  const comp = await compile(c.dir);
  const missing = comp.producedRoots.filter((r) => !comp.startDomain || !(r in comp.startDomain));
  if (comp.errors.length) throw new Error(`compile errors: ${JSON.stringify(comp.errors)}`);
  if (missing.length) throw new Error(`domain incomplete, missing produced roots: ${missing}`);
  if (!comp.startDomain || !('context' in comp.startDomain)) {
    throw new Error(`convention violated: 'context' missing from domain [${comp.startDomain ? Object.keys(comp.startDomain) : 'none'}]`);
  }
  const p = await push(context, c.dir);
  const r = await run(context, p.graphId, c.initialState, { pollMs: 3000, maxPolls: 120 });
  const failed = c.check(r.finalVariables, r);
  const pass = r.status === 'end' && failed.length === 0;
  const detail = pass
    ? `graph#${p.graphId} status=end domain✓ vars✓`
    : `graph#${p.graphId} status=${r.status} ${failed.length ? 'FAILS=' + failed.join(',') : ''} ${r.status !== 'end' ? 'err=' + JSON.stringify(r.errorData).slice(0, 300) : ''}`;
  return { pass, detail, fv: r.finalVariables };
}

for (const c of cases) {
  const name = c.dir.split('/').pop()!;
  try {
    await waitHealthy();
    let res: { pass: boolean; detail: string; fv: FV };
    try {
      res = await attempt(c);
    } catch (e) {
      if (/fetch failed|ECONN|socket/i.test((e as Error).message)) {
        console.log(`  (transient on ${name}: ${(e as Error).message} — waiting for health + retry)`);
        await waitHealthy();
        res = await attempt(c);
      } else {
        throw e;
      }
    }
    results.push({ name, pass: res.pass, detail: res.detail });
    if (res.pass) { streak++; bestStreak = Math.max(bestStreak, streak); } else { streak = 0; }
    console.log(`${res.pass ? 'PASS' : 'FAIL'}  ${name}  ${res.detail}`);
    if (!res.pass && res.fv) console.log('      finalVariables:', JSON.stringify(res.fv));
  } catch (e) {
    results.push({ name, pass: false, detail: (e as Error).message });
    streak = 0;
    console.log(`FAIL  ${name}  ${(e as Error).message}`);
  }
}

const passes = results.filter((r) => r.pass).length;
console.log(`\n==== ${passes}/${results.length} passed; longest consecutive streak = ${bestStreak} ====`);
process.exit(passes === results.length ? 0 : 1);
