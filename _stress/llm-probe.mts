/** Show the field shape of an LLM config (secrets masked) and the matching model ids. */
import { connect } from './lib.mjs';
import { LlmApi } from '../src/api/llm.js';

const configName = process.argv[2] ?? process.env.STRESS_LLM_CONFIG ?? 'stress-4o-mini';
const modelPattern = new RegExp(process.env.STRESS_LLM_MODEL ?? 'gpt-4o-mini', 'i');
const context = await connect();
const llm = new LlmApi(context.client);
const config = (await llm.listConfigs()).find((candidate) => candidate.custom_name === configName);
if (!config) {
  console.log(`no llm-config named "${configName}" — run _stress/provision-llm.mts first`);
} else {
  const fields = await context.client.get<Record<string, unknown>>(`llm-configs/${config.id}/`);
  const masked: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    masked[field] =
      typeof value === 'string' && (field.toLowerCase().includes('key') || value.startsWith('sk-')) ? '<masked>' : value;
  }
  console.log(`LLM_CONFIG "${configName}" (#${config.id}):`, JSON.stringify(masked, null, 2));
}
const models = (await llm.listModels()).filter((model) => modelPattern.test(model.name));
console.log('matching models:', JSON.stringify(models.map((model) => ({ id: model.id, name: model.name, provider: model.llm_provider }))));
