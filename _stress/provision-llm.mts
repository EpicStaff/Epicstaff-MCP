/**
 * Provision the LLM config the stress flows reference as { existing: "stress-4o-mini" }.
 * Idempotent: creates it on a fresh instance, updates it otherwise.
 *
 *   STRESS_OPENAI_KEY        OpenAI key (stored as the org secret "es-mcp:STRESS_OPENAI_KEY",
 *                            the same secret flows with api_key_env: STRESS_OPENAI_KEY use)
 *   STRESS_LLM_CONFIG        config name   (default stress-4o-mini)
 *   STRESS_LLM_MODEL         model name    (default gpt-4o-mini)
 *   STRESS_LLM_PROVIDER      provider name (default openai)
 *
 * Never prints the key. The model id is resolved by name on the target instance.
 */
import { connect } from './lib.mjs';
import { LlmApi } from '../src/api/llm.js';
import { SecretsApi, secretTail } from '../src/api/secrets.js';
import { secretName } from '../src/compiler/template-refs.js';

const KEY_ENV = 'STRESS_OPENAI_KEY';
const key = process.env[KEY_ENV];
if (!key) throw new Error(`${KEY_ENV} is not set`);
const configName = process.env.STRESS_LLM_CONFIG ?? 'stress-4o-mini';
const modelName = process.env.STRESS_LLM_MODEL ?? 'gpt-4o-mini';
const providerName = (process.env.STRESS_LLM_PROVIDER ?? 'openai').toLowerCase();

const context = await connect();
const llm = new LlmApi(context.client);
const secrets = new SecretsApi(context.client, context.auth);

const name = secretName(KEY_ENV);
let secret = await secrets.findByName(name);
if (secret && secret.tail !== secretTail(key)) {
  throw new Error(`org secret "${name}" holds a different key — delete it in EpicStaff and rerun`);
}
secret ??= await secrets.create(name, key);

const body = {
  custom_name: configName,
  // The backend resolves the model from the two names (EpicStaff 1.6).
  provider: providerName,
  model_name: modelName,
  api_key_secret_id: secret.id,
  parameters: { temperature: 0, max_tokens: 1000 },
  timeout: 120,
  is_visible: true,
};
const existing = (await llm.listConfigs()).find((config) => config.custom_name === configName);
const result = existing ? await llm.updateConfig(existing.id, body) : await llm.createConfig(body);
console.log(`${existing ? 'UPDATED' : 'CREATED'} llm-config #${result.id} "${configName}" → model ${providerName}/${modelName} (#${result.model})`);
