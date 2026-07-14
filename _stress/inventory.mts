import { connect } from './lib.mjs';

const context = await connect();
const org = await context.org.resolve();
console.log('ORGS:', JSON.stringify(org.organizations), 'active:', org.activeOrgId);

async function list(path: string, label: string): Promise<void> {
  try {
    const res = await context.client.get<any>(path);
    const items = Array.isArray(res) ? res : (res.results ?? res.data ?? []);
    console.log(`\n${label} (${items.length}):`);
    for (const it of items.slice(0, 15)) {
      console.log('  ', JSON.stringify({ id: it.id, name: it.name ?? it.custom_name ?? it.model, model: it.model, provider: it.provider }));
    }
  } catch (e) {
    console.log(`\n${label}: ERROR ${(e as Error).message}`);
  }
}

await list('llm-configs/?limit=1000', 'LLM_CONFIGS');
await list('providers/?limit=1000', 'PROVIDERS');
await list('agent-definitions/?limit=1000', 'AGENT_DEFINITIONS');
await list('graph-light/?limit=1000', 'GRAPHS');
await list('llm-models/?limit=5', 'LLM_MODELS(sample)');
