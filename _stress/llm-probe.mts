import { connect } from './lib.mjs';
const context = await connect();
// Field shape of an existing config (mask any secret-looking value).
const cfg = await context.client.get<any>('llm-configs/5/');
const masked: Record<string, unknown> = {};
for (const [k, v] of Object.entries(cfg)) {
  masked[k] = typeof v === 'string' && (k.toLowerCase().includes('key') || v.startsWith('sk-')) ? `<${v ? 'set:' + v.length : 'empty'}>` : v;
}
console.log('LLM_CONFIG#5 fields:', JSON.stringify(masked, null, 2));
// Find gpt-4o-mini model id.
const models = await context.client.get<any>('llm-models/?limit=1000');
const items = Array.isArray(models) ? models : (models.results ?? []);
const mini = items.filter((m: any) => /gpt-4o-mini/i.test(m.name ?? ''));
console.log('gpt-4o-mini models:', JSON.stringify(mini.map((m: any) => ({ id: m.id, name: m.name, provider: m.provider }))));
