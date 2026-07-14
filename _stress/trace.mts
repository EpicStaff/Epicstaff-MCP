import { connect } from './lib.mjs';
import { SessionsApi } from '../src/api/sessions.js';
const context = await connect();
const sessions = new SessionsApi(context.client);
for (const graphId of process.argv.slice(2).map(Number)) {
  const list = await sessions.listSessions({ graphId, limit: 1 });
  const s = (list as any).results?.[0] ?? (Array.isArray(list) ? list[0] : null);
  if (!s) { console.log(`graph ${graphId}: no sessions`); continue; }
  console.log(`\n===== graph #${graphId} session #${s.id} status=${s.status} =====`);
  const page = await sessions.getSessionMessages(s.id, 200, 0);
  for (const m of page.results as any[]) {
    const d = m.message_data ?? {};
    const kind = d.message_type ?? m.message_type ?? '?';
    const who = m.name ?? d.name ?? '';
    let text = d.text ?? d.details ?? d.result ?? d.output ?? '';
    if (typeof text !== 'string') text = JSON.stringify(text);
    console.log(`  [${kind}] ${who}: ${String(text).slice(0, 160)}`);
  }
}
