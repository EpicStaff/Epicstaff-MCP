import { connect } from './lib.mjs';

const key = process.env.STRESS_OPENAI_KEY;
if (!key) throw new Error('STRESS_OPENAI_KEY not set');
const NAME = 'stress-4o-mini';
const MODEL_ID = 37; // gpt-4o-mini

const context = await connect();
const existing = await context.client.get<any>('llm-configs/?limit=1000');
const items = Array.isArray(existing) ? existing : (existing.results ?? []);
const found = items.find((c: any) => c.custom_name === NAME);

const body = {
  custom_name: NAME,
  model: MODEL_ID,
  api_key: key,
  temperature: 0,
  max_tokens: 1000,
  timeout: 120,
  is_visible: true,
};

let result: any;
if (found) {
  result = await context.client.patch<any>(`llm-configs/${found.id}/`, { body });
  console.log('UPDATED llm-config', result.id, result.custom_name, 'model', result.model);
} else {
  result = await context.client.post<any>('llm-configs/', { body });
  console.log('CREATED llm-config', result.id, result.custom_name, 'model', result.model);
}
