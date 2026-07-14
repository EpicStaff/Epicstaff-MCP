import { connect, compile, push, run } from './lib.mjs';

const dir = process.argv[2]!;
const initialState = JSON.parse(process.argv[3] ?? '{}');

const c = await compile(dir);
console.log('== COMPILE', c.flowName, '==');
console.log('errors:', JSON.stringify(c.errors));
console.log('warnings:', JSON.stringify(c.warnings));
console.log('startDomain keys:', c.startDomain ? Object.keys(c.startDomain) : null);
console.log('producedRoots:', JSON.stringify(c.producedRoots));
const missing = c.producedRoots.filter((r) => !c.startDomain || !(r in c.startDomain));
console.log('DOMAIN COMPLETE:', missing.length === 0, missing.length ? `missing=${missing}` : '');
if (c.errors.length) { console.log('ABORT: compile errors'); process.exit(2); }

const context = await connect();
const p = await push(context, dir);
console.log('== PUSH == graphId', p.graphId, 'saveVersion', p.saveVersion);

const r = await run(context, p.graphId, initialState, { pollMs: 3000, maxPolls: 100 });
console.log('== RUN == session', r.sessionId, 'status', r.status);
console.log('finalVariables:', JSON.stringify(r.finalVariables));
console.log('finalReply:', JSON.stringify(r.finalReply));
if (r.status !== 'end') { console.log('errorData:', JSON.stringify(r.errorData)); console.log('timeline:', JSON.stringify(r.timeline, null, 2)); }
