import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { truncateStrings } from '../src/tools/voice-agent.tools.js';
import { connectTools, type ToolCallResult } from './helpers/mcp-harness.js';

/**
 * The voice tools (voice configs, agent voice settings, voice channels, chat history and the
 * default-model voice slots) over the real MCP path — Zod parsing included — against an in-process
 * mock backend that records every request.
 */
const ENV = { EPICSTAFF_BASE_URL: 'http://es.mock', EPICSTAFF_USERNAME: 'dev@example.com', EPICSTAFF_PASSWORD: 'pw' };
const encodeSegment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const MOCK_JWT = `${encodeSegment({ alg: 'HS256' })}.${encodeSegment({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const SECRET_VALUE = 'sk-voice-super-secret-value-9876';
const TWILIO_TOKEN_VALUE = 'twilio-auth-token-value-abcdef';
const ACCOUNT_SID = `AC${'a1'.repeat(16)}`;
const CHANNEL_TOKEN = '5b1c7b0e-0000-4000-8000-00000000c0de';
const CONNECTION_KEY = 'conn-key-of-chat-31';

interface Received {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Route = (request: Received) => Reply | Promise<Reply>;

const page = (results: unknown[]) => ({ count: results.length, next: null, previous: null, results });

describe('voice tools (mock backend)', () => {
  let stateDir: string;
  let client: Client;
  let call: (name: string, args?: Record<string, unknown>) => Promise<ToolCallResult>;
  let received: Received[];
  let routes: Map<string, Route>;

  const route = (key: string, handler: Route | Reply): void => {
    routes.set(key, typeof handler === 'function' ? handler : () => handler);
  };
  const requests = (method: string, path: string): Received[] =>
    received.filter((request) => request.method === method && request.path === path);

  /** Agents 7 (Concierge) and 8 (Support); one OpenAI and one Gemini voice config; the voice list. */
  const seedCatalog = (): void => {
    route('GET /api/agent-definitions/', { status: 200, body: page([{ id: 7, name: 'Concierge' }, { id: 8, name: 'Support' }]) });
    route('GET /api/openai-realtime-configs/', {
      status: 200,
      body: page([{ id: 11, custom_name: 'oa-voice', model_name: 'gpt-realtime-1.5', api_key_secret_id: 21 }]),
    });
    route('GET /api/elevenlabs-realtime-configs/', { status: 200, body: page([]) });
    route('GET /api/gemini-realtime-configs/', {
      status: 200,
      body: page([{ id: 12, custom_name: 'gm-voice', model_name: 'gemini-3.1-flash-live-preview', api_key_secret_id: 21 }]),
    });
    route('GET /api/realtime-voices/', {
      status: 200,
      body: { openai: [{ id: 'alloy', name: 'Alloy' }, { id: 'marin', name: 'Marin' }], gemini: [{ id: 'Puck', name: 'Puck' }] },
    });
  };

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'es-mcp-voice-'));
    process.env.ES_MCP_STATE_DIR = stateDir;
    received = [];
    routes = new Map();
    route('GET /api/auth/api-key/validate/', { status: 200, body: { active: true } });
    route('GET /api/profile/', { status: 200, body: { memberships: [{ organization: { id: 1, name: 'Org', is_active: true } }] } });
    route('POST /api/auth/login/', { status: 200, body: { access: MOCK_JWT }, headers: { 'Set-Cookie': 'auth.refresh=r; Path=/api/auth/' } });

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const raw = init?.body;
      const request: Received = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        body: typeof raw === 'string' ? JSON.parse(raw) : raw,
      };
      received.push(request);
      const handler = routes.get(`${request.method} ${request.path}`);
      const reply = handler ? await handler(request) : { status: 404, body: { detail: `no mock for ${request.method} ${request.path}` } };
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'Content-Type': 'application/json', ...reply.headers },
      });
    });

    const context = createContext(loadConfig(ENV));
    context.store.update({ apiKey: 'stored-key', keyPrefix: 'stored-k', activeOrgId: 1 });
    ({ client, call } = await connectTools(context));
  });

  afterEach(async () => {
    await client.close();
    vi.unstubAllGlobals();
    delete process.env.ES_MCP_STATE_DIR;
    delete process.env.VOICE_TEST_KEY;
    delete process.env.TWILIO_TEST_TOKEN;
    rmSync(stateDir, { recursive: true, force: true });
  });

  // ----- voice configs ---------------------------------------------------------------

  it('create_voice_config stores both OpenAI keys from env as org secrets and sends only their ids', async () => {
    process.env.VOICE_TEST_KEY = SECRET_VALUE;
    route('GET /api/openai-realtime-configs/', { status: 200, body: page([]) });
    const storedSecrets: unknown[] = [];
    route('GET /api/secrets/', () => ({ status: 200, body: page(storedSecrets) }));
    route('POST /api/secrets/', () => {
      const secret = { id: 21, name: 'es-mcp:VOICE_TEST_KEY', tail: '9876' };
      storedSecrets.push(secret);
      return { status: 201, body: secret };
    });
    route('POST /api/openai-realtime-configs/', (request) => ({ status: 201, body: { id: 11, ...(request.body as object) } }));

    const result = await call('create_voice_config', {
      provider: 'openai',
      name: 'oa-voice',
      api_key_env: 'VOICE_TEST_KEY',
      transcription_api_key_secret: 'es-mcp:VOICE_TEST_KEY',
      voice_recognition_prompt: 'Expect product names',
    });

    expect(result.isError, result.text).toBe(false);
    expect(requests('POST', '/api/secrets/')[0]?.body).toEqual({ name: 'es-mcp:VOICE_TEST_KEY', value: SECRET_VALUE });
    expect(requests('POST', '/api/openai-realtime-configs/')[0]?.body).toEqual({
      custom_name: 'oa-voice',
      api_key_secret_id: 21,
      transcription_api_key_secret_id: 21,
      voice_recognition_prompt: 'Expect product names',
    });
    expect(result.body.data.config).toMatchObject({ provider: 'openai', id: 11 });
    expect(result.body.data.warnings).toBeUndefined();
    expect(result.text).not.toContain(SECRET_VALUE);
  });

  it('create_voice_config refuses a field the provider does not have, before any write', async () => {
    const result = await call('create_voice_config', { provider: 'gemini', name: 'g', language: 'en', base_url: 'https://x.example' });

    expect(result.isError).toBe(true);
    expect(result.body.error).toMatch(/gemini voice config has no base_url \(openai only\), language \(elevenlabs only\)/);
    expect(received.filter((request) => request.method === 'POST')).toHaveLength(0);
  });

  it('create_voice_config warns about a duplicate name and a missing key', async () => {
    route('GET /api/elevenlabs-realtime-configs/', { status: 200, body: page([{ id: 3, custom_name: 'EL' }]) });
    route('POST /api/elevenlabs-realtime-configs/', (request) => ({ status: 201, body: { id: 4, ...(request.body as object) } }));

    const { body } = await call('create_voice_config', { provider: 'elevenlabs', name: 'el', language: 'de' });

    expect(requests('POST', '/api/elevenlabs-realtime-configs/')[0]?.body).toEqual({
      custom_name: 'el',
      api_key_secret_id: null,
      language: 'de',
    });
    expect(body.data.warnings).toEqual([
      expect.stringMatching(/already has this name \(id 3\)/),
      expect.stringMatching(/No API key/),
    ]);
  });

  it('update_voice_config resolves the name within the provider and PATCHes only the given fields', async () => {
    seedCatalog();
    route('PATCH /api/gemini-realtime-configs/12/', (request) => ({ status: 200, body: { id: 12, custom_name: 'gm-voice', ...(request.body as object) } }));

    await call('update_voice_config', { provider: 'gemini', config: 'GM-VOICE', model_name: 'gemini-live-2', voice_recognition_prompt: null });

    expect(requests('PATCH', '/api/gemini-realtime-configs/12/')[0]?.body).toEqual({
      model_name: 'gemini-live-2',
      voice_recognition_prompt: null,
    });
  });

  it('delete_voice_config uses the provider bulk-delete route with dry_run', async () => {
    seedCatalog();
    route('POST /api/openai-realtime-configs/bulk-delete/', {
      status: 200,
      body: { dry_run: true, deleted_count: 0, deleted_ids: [], deletable_ids: [], not_found_ids: [], skipped: [{ id: 11, reason: 'in_use_restricted' }], usage: {} },
    });

    const { body } = await call('delete_voice_config', { provider: 'openai', config: 'oa-voice', dry_run: true });

    const request = requests('POST', '/api/openai-realtime-configs/bulk-delete/')[0]!;
    expect(request.body).toEqual({ ids: [11] });
    expect(request.query.get('dry_run')).toBe('true');
    expect(body.data.skipped).toEqual([{ id: 11, reason: 'in_use_restricted' }]);
  });

  it('list_voice_configs merges the providers and adds models, voices and legacy configs on request', async () => {
    seedCatalog();
    route('GET /api/realtime-models/', { status: 200, body: page([{ id: 1, name: 'gpt-realtime-1.5', provider: 5, is_custom: false }]) });
    route('GET /api/realtime-transcription-models/', { status: 200, body: page([{ id: 2, name: 'whisper-1', provider: 5, is_custom: false }]) });
    route('GET /api/providers/', { status: 200, body: page([{ id: 5, name: 'openai' }]) });
    route('GET /api/realtime-model-configs/', { status: 200, body: page([{ id: 40, custom_name: 'old-voice', realtime_model: 1, api_key_secret_id: null }]) });
    route('GET /api/realtime-transcription-model-configs/', { status: 200, body: page([]) });

    const { body } = await call('list_voice_configs', { include_models: true, include_voices: true, include_legacy: true });

    expect(body.data.configs).toEqual([
      expect.objectContaining({ provider: 'openai', id: 11, name: 'oa-voice', has_api_key: true, has_transcription_api_key: false }),
      expect.objectContaining({ provider: 'gemini', id: 12, name: 'gm-voice' }),
    ]);
    expect(body.data.models.realtime).toEqual([{ id: 1, name: 'gpt-realtime-1.5', provider: 'openai', is_custom: false }]);
    expect(body.data.voices.gemini).toEqual(['Puck']);
    expect(body.data.legacy.realtime_configs).toEqual([{ id: 40, name: 'old-voice', model: 1, provider: null, has_api_key: false }]);
  });

  it('create_voice_model registers a custom model under the provider id', async () => {
    route('GET /api/providers/', { status: 200, body: page([{ id: 5, name: 'openai' }, { id: 6, name: 'gemini' }]) });
    route('POST /api/realtime-models/', (request) => ({ status: 201, body: { id: 9, is_custom: true, ...(request.body as object) } }));

    const { body } = await call('create_voice_model', { provider: 'openai', name: ' gpt-realtime ' });

    expect(requests('POST', '/api/realtime-models/')[0]?.body).toEqual({ name: 'gpt-realtime', provider: 5 });
    expect(body.data.model).toEqual({ id: 9, name: 'gpt-realtime', provider: 'openai', is_custom: true });
  });

  it('delete_voice_model resolves names among custom models only', async () => {
    route('GET /api/realtime-models/', {
      status: 200,
      body: page([
        { id: 1, name: 'gpt-realtime-1.5', provider: 5, is_custom: false },
        { id: 9, name: 'gpt-realtime', provider: 5, is_custom: true },
      ]),
    });
    route('DELETE /api/realtime-models/9/', { status: 204 });

    const refused = await call('delete_voice_model', { model: 'gpt-realtime-1.5' });
    expect(refused.body.error).toMatch(/not found/);

    const { isError } = await call('delete_voice_model', { model: 'gpt-realtime' });
    expect(isError).toBe(false);
    expect(requests('DELETE', '/api/realtime-models/9/')).toHaveLength(1);
  });

  // ----- default-model voice slots ------------------------------------------------------

  it('update_default_models resolves the legacy voice and transcription slots by name', async () => {
    route('GET /api/realtime-model-configs/', { status: 200, body: page([{ id: 40, custom_name: 'old-voice', realtime_model: 1, api_key_secret_id: null }]) });
    route('PUT /api/default-models/', (request) => ({ status: 200, body: request.body }));

    await call('update_default_models', { voice_llm_config: 'old-voice', transcription_llm_config: null });

    expect(requests('PUT', '/api/default-models/')[0]?.body).toEqual({ voice_llm_config: 40, transcription_llm_config: null });
  });

  it('get_settings names the legacy voice slot and reads the transcription list only when its slot is set', async () => {
    route('GET /api/default-models/', {
      status: 200,
      body: {
        agent_llm_config: null,
        agent_fcm_llm_config: null,
        project_manager_llm_config: null,
        memory_llm_config: null,
        memory_embedding_config: null,
        voice_llm_config: 40,
        transcription_llm_config: null,
      },
    });
    route('GET /api/llm-configs/', { status: 200, body: page([]) });
    route('GET /api/embedding-configs/', { status: 200, body: page([]) });
    route('GET /api/execution-timeout-limits/', { status: 200, body: { default_seconds: 60 } });
    route('GET /api/recycle-bin/settings/', { status: 200, body: { retention_days: 30 } });
    route('GET /api/quickstart/', { status: 200, body: { supported_providers: [], last_config: null, is_synced: false } });
    route('GET /api/realtime-model-configs/', { status: 200, body: page([{ id: 40, custom_name: 'old-voice', realtime_model: 1, api_key_secret_id: null }]) });

    const { body } = await call('get_settings');

    expect(body.data.default_models.voice_llm_config).toEqual({ id: 40, name: 'old-voice' });
    expect(body.data.default_models.transcription_llm_config).toBeNull();
    expect(requests('GET', '/api/realtime-transcription-model-configs/')).toHaveLength(0);
  });

  // ----- agent voice settings ------------------------------------------------------------

  it('set_agent_voice creates the settings like the agent dialog: only the chosen provider config is set', async () => {
    seedCatalog();
    route('GET /api/realtime-agent-definitions/7/', { status: 404, body: { detail: 'Not found.' } });
    route('POST /api/realtime-agent-definitions/', (request) => ({
      status: 201,
      body: { wake_word: 'Concierge', stop_prompt: 'stop', language: null, voice_recognition_prompt: null, voice: 'alloy', ...(request.body as object) },
    }));

    const { isError, body } = await call('set_agent_voice', { agent: 'concierge', provider: 'openai', config: 'oa-voice', voice: 'marin', language: 'en' });

    expect(isError, JSON.stringify(body)).toBe(false);
    expect(requests('POST', '/api/realtime-agent-definitions/')[0]?.body).toEqual({
      agent_definition: 7,
      voice: 'marin',
      language: 'en',
      openai_config: 11,
      elevenlabs_config: null,
      gemini_config: null,
    });
    expect(body.data.created).toBe(true);
    expect(body.data.voice_settings).toMatchObject({
      agent: { id: 7, name: 'Concierge' },
      enabled: true,
      provider: 'openai',
      config: { id: 11, name: 'oa-voice' },
      voice: 'marin',
    });
  });

  it('set_agent_voice refuses a voice the provider lacks — including a stale one on a provider switch', async () => {
    seedCatalog();
    route('GET /api/realtime-agent-definitions/7/', {
      status: 200,
      body: { agent_definition: 7, openai_config: 11, elevenlabs_config: null, gemini_config: null, voice: 'alloy' },
    });

    const switched = await call('set_agent_voice', { agent: 7, provider: 'gemini', config: 'gm-voice' });
    expect(switched.body.error).toMatch(/gemini has no voice "alloy" \(the current voice\).*Puck/);

    const eleven = await call('set_agent_voice', { agent: 7, provider: 'elevenlabs', config: 1 });
    expect(eleven.body.error).toMatch(/ElevenLabs takes a free-form voice id/);

    expect(received.filter((request) => request.method === 'PATCH' || request.method === 'POST')).toHaveLength(0);
  });

  it('set_agent_voice provider: null switches voice off with a PATCH of all three configs', async () => {
    seedCatalog();
    route('GET /api/realtime-agent-definitions/7/', {
      status: 200,
      body: { agent_definition: 7, openai_config: 11, elevenlabs_config: null, gemini_config: null, voice: 'alloy' },
    });
    route('PATCH /api/realtime-agent-definitions/7/', (request) => ({
      status: 200,
      body: { agent_definition: 7, voice: 'alloy', ...(request.body as object) },
    }));

    const { body } = await call('set_agent_voice', { agent: 'Concierge', provider: null });

    expect(requests('PATCH', '/api/realtime-agent-definitions/7/')[0]?.body).toEqual({
      openai_config: null,
      elevenlabs_config: null,
      gemini_config: null,
    });
    expect(body.data.voice_settings.enabled).toBe(false);
  });

  it('list_voice_agents names the agent and its config, and reports an agent without settings', async () => {
    seedCatalog();
    route('GET /api/realtime-agent-definitions/', {
      status: 200,
      body: page([{ agent_definition: 7, openai_config: null, elevenlabs_config: null, gemini_config: 12, voice: 'Puck', wake_word: 'hey', stop_prompt: 'stop', language: null, voice_recognition_prompt: null }]),
    });
    route('GET /api/realtime-agent-definitions/8/', { status: 404, body: { detail: 'Not found.' } });

    const all = await call('list_voice_agents');
    expect(all.body.data).toEqual([
      expect.objectContaining({ agent: { id: 7, name: 'Concierge' }, enabled: true, provider: 'gemini', config: { id: 12, name: 'gm-voice' } }),
    ]);

    const one = await call('list_voice_agents', { agent: 'Support' });
    expect(one.body.data).toEqual({ agent: { id: 8, name: 'Support' }, configured: false, enabled: false });
  });

  it('delete_agent_voice deletes the row and names the channels left without a destination', async () => {
    seedCatalog();
    route('GET /api/realtime-agent-definitions/7/', { status: 200, body: { agent_definition: 7, openai_config: 11 } });
    route('GET /api/realtime-channels/', { status: 200, body: page([{ id: 50, name: 'Hotline', realtime_agent_definition: 7 }, { id: 51, name: 'Other', realtime_agent_definition: 8 }]) });
    route('DELETE /api/realtime-agent-definitions/7/', { status: 204 });

    const { body } = await call('delete_agent_voice', { agent: 'Concierge' });

    expect(requests('DELETE', '/api/realtime-agent-definitions/7/')).toHaveLength(1);
    expect(body.data.channels_without_destination).toEqual([{ id: 50, name: 'Hotline' }]);
  });

  // ----- voice channels ------------------------------------------------------------------

  const channelRow = (twilio: unknown) => ({
    id: 50,
    name: 'Hotline',
    channel_type: 'twilio',
    token: CHANNEL_TOKEN,
    realtime_agent: null,
    realtime_agent_definition: 7,
    is_enabled: true,
    twilio,
    created_at: '2026-10-29T00:00:00Z',
    created_by: { id: 1, display_name: 'Ada', avatar_url: null },
    last_edited_by: null,
    last_edited_at: null,
  });
  const twilioRow = {
    channel: 50,
    account_sid: ACCOUNT_SID,
    auth_token_secret_id: 22,
    phone_number: '+15550001111',
    webhook_trigger: { id: 3, path: 'voice', provider_type: 'ngrok', ngrok_config: null, localhost_config: null, live_url: 'https://x.ngrok.app/voice' },
  };

  it('create_voice_channel saves channel, then Twilio settings, then points the number at the channel', async () => {
    process.env.TWILIO_TEST_TOKEN = TWILIO_TOKEN_VALUE;
    seedCatalog();
    route('GET /api/realtime-agent-definitions/7/', { status: 200, body: { agent_definition: 7, openai_config: 11, voice: 'alloy' } });
    route('GET /api/secrets/', { status: 200, body: page([]) });
    route('POST /api/secrets/', { status: 201, body: { id: 22, name: 'es-mcp:TWILIO_TEST_TOKEN', tail: 'cdef' } });
    route('POST /api/realtime-channels/', { status: 201, body: channelRow(null) });
    route('POST /api/twilio-channels/', (request) => ({ status: 201, body: request.body }));
    route('GET /api/twilio-channels/phone-numbers/', {
      status: 200,
      body: { results: [{ sid: `PN${'b'.repeat(32)}`, phone_number: '+15550001111', friendly_name: 'Main', voice_url: null }] },
    });
    route('POST /api/twilio/configure-webhook/', { status: 200, body: { webhook_url: `https://x.ngrok.app/voice/${CHANNEL_TOKEN}` } });
    route('GET /api/realtime-channels/50/', { status: 200, body: channelRow(twilioRow) });

    const result = await call('create_voice_channel', {
      name: 'Hotline',
      agent: 'Concierge',
      account_sid: ACCOUNT_SID,
      auth_token_env: 'TWILIO_TEST_TOKEN',
      phone_number: '+15550001111',
      webhook_trigger: 3,
    });

    expect(result.isError, result.text).toBe(false);
    expect(requests('POST', '/api/realtime-channels/')[0]?.body).toEqual({
      name: 'Hotline',
      channel_type: 'twilio',
      realtime_agent_definition: 7,
      is_enabled: true,
    });
    expect(requests('POST', '/api/twilio-channels/')[0]?.body).toEqual({
      channel: 50,
      account_sid: ACCOUNT_SID,
      auth_token_secret_id: 22,
      phone_number: '+15550001111',
      webhook_trigger: 3,
    });
    const phoneLookup = requests('GET', '/api/twilio-channels/phone-numbers/')[0]!;
    expect(phoneLookup.query.get('sid')).toBe(ACCOUNT_SID);
    expect(phoneLookup.query.get('auth_token_secret_id')).toBe('22');
    expect(requests('POST', '/api/twilio/configure-webhook/')[0]?.body).toEqual({
      phone_sid: `PN${'b'.repeat(32)}`,
      channel_token: CHANNEL_TOKEN,
    });
    expect(result.body.data.webhook).toEqual({ configured: true, webhook_url: 'https://x.ngrok.app/voice/<channel token>' });
    expect(result.body.data.channel).toMatchObject({
      id: 50,
      agent: { id: 7, name: 'Concierge' },
      twilio: { phone_number: '+15550001111', has_auth_token: true, webhook_trigger: { id: 3, live_url: 'https://x.ngrok.app/voice' } },
    });
    expect(result.text).not.toContain(CHANNEL_TOKEN);
    expect(result.text).not.toContain(TWILIO_TOKEN_VALUE);
  });

  it('create_voice_channel reports the created channel when its Twilio settings are refused', async () => {
    route('GET /api/secrets/', { status: 200, body: page([{ id: 22, name: 'twilio-token', tail: '' }]) });
    route('POST /api/realtime-channels/', { status: 201, body: channelRow(null) });
    route('POST /api/twilio-channels/', {
      status: 400,
      body: { errors: [{ field: 'webhook_trigger', reason: 'Localhost webhook provider is not reachable by Twilio.' }] },
    });

    const { isError, body } = await call('create_voice_channel', {
      name: 'Hotline',
      account_sid: ACCOUNT_SID,
      auth_token_secret: 'twilio-token',
      webhook_trigger: 4,
    });

    expect(isError).toBe(true);
    expect(body.error).toMatch(/was created \(id 50\).*Localhost webhook provider.*update_voice_channel\(channel: 50/);
  });

  it('create_voice_channel refuses an agent without voice settings before creating anything', async () => {
    seedCatalog();
    route('GET /api/realtime-agent-definitions/8/', { status: 404, body: { detail: 'Not found.' } });

    const { body } = await call('create_voice_channel', { name: 'x', agent: 'Support', account_sid: ACCOUNT_SID, auth_token_secret: 1 });

    expect(body.error).toMatch(/no voice settings — give it a voice with set_agent_voice/);
    expect(requests('POST', '/api/realtime-channels/')).toHaveLength(0);
  });

  it('update_voice_channel PATCHes the Twilio row and reconfigures the webhook when a Twilio setting changes', async () => {
    seedCatalog();
    route('GET /api/realtime-channels/', { status: 200, body: page([channelRow(twilioRow)]) });
    route('GET /api/realtime-channels/50/', { status: 200, body: channelRow(twilioRow) });
    route('PATCH /api/twilio-channels/50/', (request) => ({ status: 200, body: { ...twilioRow, ...(request.body as object) } }));
    route('GET /api/twilio-channels/phone-numbers/', { status: 200, body: { results: [] } });

    const { body } = await call('update_voice_channel', { channel: 'Hotline', phone_number: '+15550001111' });

    expect(requests('PATCH', '/api/twilio-channels/50/')[0]?.body).toEqual({ phone_number: '+15550001111' });
    expect(requests('PATCH', '/api/realtime-channels/50/')).toHaveLength(0);
    expect(body.data.webhook).toEqual({ configured: false });
    expect(body.data.warnings).toEqual([expect.stringMatching(/has no number \+15550001111/)]);
  });

  it('update_voice_channel creates missing Twilio settings, and refuses before any write without the account', async () => {
    route('GET /api/realtime-channels/', { status: 200, body: page([channelRow(null)]) });
    let savedTwilio: unknown = null;
    route('GET /api/realtime-channels/50/', () => ({ status: 200, body: channelRow(savedTwilio) }));
    route('GET /api/agent-definitions/', { status: 200, body: page([{ id: 7, name: 'Concierge' }]) });
    route('GET /api/secrets/', { status: 200, body: page([{ id: 22, name: 'twilio-token', tail: '' }]) });
    route('POST /api/twilio-channels/', (request) => {
      savedTwilio = request.body;
      return { status: 201, body: request.body };
    });

    const refused = await call('update_voice_channel', { channel: 50, name: 'Renamed', phone_number: '+15550001111' });
    expect(refused.body.error).toMatch(/no Twilio settings yet: pass account_sid/);
    expect(received.filter((request) => request.method !== 'GET')).toHaveLength(0);

    const { isError, body } = await call('update_voice_channel', { channel: 50, account_sid: ACCOUNT_SID, auth_token_secret: 'twilio-token' });
    expect(isError, JSON.stringify(body)).toBe(false);
    expect(requests('POST', '/api/twilio-channels/')[0]?.body).toEqual({
      channel: 50,
      account_sid: ACCOUNT_SID,
      auth_token_secret_id: 22,
      phone_number: null,
      webhook_trigger: null,
    });
    expect(body.data.warnings).toEqual([expect.stringMatching(/needs a phone number, a webhook trigger/)]);
  });

  it('update_voice_channel configure_webhook: true re-points the number without other changes', async () => {
    route('GET /api/realtime-channels/', { status: 200, body: page([channelRow(twilioRow)]) });
    route('GET /api/realtime-channels/50/', { status: 200, body: channelRow(twilioRow) });
    route('GET /api/agent-definitions/', { status: 200, body: page([{ id: 7, name: 'Concierge' }]) });
    route('GET /api/twilio-channels/phone-numbers/', {
      status: 200,
      body: { results: [{ sid: `PN${'c'.repeat(32)}`, phone_number: '+15550001111', friendly_name: 'Main', voice_url: null }] },
    });
    route('POST /api/twilio/configure-webhook/', { status: 200, body: { webhook_url: `https://y.ngrok.app/voice/${CHANNEL_TOKEN}` } });

    const { isError, body } = await call('update_voice_channel', { channel: 50, configure_webhook: true });

    expect(isError, JSON.stringify(body)).toBe(false);
    expect(requests('POST', '/api/twilio/configure-webhook/')[0]?.body).toEqual({ phone_sid: `PN${'c'.repeat(32)}`, channel_token: CHANNEL_TOKEN });
    expect(received.filter((request) => request.method === 'PATCH')).toHaveLength(0);
    expect(body.data.webhook).toEqual({ configured: true, webhook_url: 'https://y.ngrok.app/voice/<channel token>' });
  });

  it('delete_voice_channel bins the channel and points at the recycle bin', async () => {
    route('GET /api/realtime-channels/', { status: 200, body: page([channelRow(null)]) });
    route('GET /api/realtime-channels/50/', { status: 200, body: channelRow(null) });
    route('DELETE /api/realtime-channels/50/', { status: 204 });

    const { body } = await call('delete_voice_channel', { channel: 50 });

    expect(requests('DELETE', '/api/realtime-channels/50/')).toHaveLength(1);
    expect(body.data.next).toMatch(/restore_from_recycle_bin\(kind: "realtime_channel", ids: \[50\]\)/);
  });

  it('list_twilio_phone_numbers reads with the channel\'s account and auth-token secret', async () => {
    route('GET /api/realtime-channels/', { status: 200, body: page([channelRow(twilioRow)]) });
    route('GET /api/realtime-channels/50/', { status: 200, body: channelRow(twilioRow) });
    route('GET /api/twilio-channels/phone-numbers/', {
      status: 200,
      body: {
        results: [
          { sid: 'PN1', phone_number: '+1', friendly_name: 'a', voice_url: null },
          { sid: 'PN2', phone_number: '+2', friendly_name: 'b', voice_url: `https://x.ngrok.app/voice/${CHANNEL_TOKEN.toUpperCase()}` },
        ],
      },
    });

    const { body, text } = await call('list_twilio_phone_numbers', { channel: 'Hotline' });

    expect(requests('GET', '/api/twilio-channels/phone-numbers/')[0]?.query.get('auth_token_secret_id')).toBe('22');
    expect(body.data).toEqual({
      account_sid: ACCOUNT_SID,
      numbers: [
        { sid: 'PN1', phone_number: '+1', friendly_name: 'a', voice_url: null, routed_to_channel: null },
        { sid: 'PN2', phone_number: '+2', friendly_name: 'b', voice_url: 'https://x.ngrok.app/voice/<channel token>', routed_to_channel: { id: 50, name: 'Hotline' } },
      ],
    });
    expect(text.toLowerCase()).not.toContain(CHANNEL_TOKEN);
  });

  // ----- chat history ----------------------------------------------------------------------

  it('get_voice_chat lists recordings and the chat\'s events without exposing its connection key', async () => {
    seedCatalog();
    route('GET /api/realtime-agent-chats/31/', {
      status: 200,
      body: {
        id: 31,
        connection_key: CONNECTION_KEY,
        created_at: '2026-10-29T10:00:00Z',
        ended_at: '2026-10-29T10:02:00Z',
        duration_seconds: 120,
        end_reason: 'completed',
        voice: 'alloy',
        language: null,
        rt_agent_definition: 7,
        openai_config: 11,
        elevenlabs_config: null,
        gemini_config: null,
      },
    });
    route('GET /api/conversation-recordings/', (request) => ({
      status: 200,
      body: page(
        request.query.get('rt_agent_chat') === '31'
          ? [{ id: 2, file: 'http://es.mock/media/recordings/a.wav', recording_type: 'inbound', audio_format: 'wav', duration_seconds: 118, file_size: 1000, created_at: 'x', rt_agent_chat: 31 }]
          : [],
      ),
    }));
    route('GET /api/realtime-session-items/', (request) => {
      const all = [
        { id: 5, connection_key: CONNECTION_KEY, created_at: 'b', data: { type: 'response.audio_transcript.done', transcript: 'Hello!' } },
        { id: 4, connection_key: 'other-chat', created_at: 'a', data: { type: 'x' } },
        { id: 3, connection_key: CONNECTION_KEY, created_at: 'a', data: { type: 'session.update', instructions: 'y'.repeat(600) } },
      ];
      const offset = Number(request.query.get('offset'));
      return { status: 200, body: { count: all.length, results: all.slice(offset, offset + Number(request.query.get('limit'))) } };
    });

    const { isError, body, text } = await call('get_voice_chat', { chat: 31, include_events: true });

    expect(isError, text).toBe(false);
    expect(body.data.chat).toMatchObject({ id: 31, agent: { id: 7, name: 'Concierge' }, provider: 'openai', end_reason: 'completed' });
    expect(body.data.recordings).toEqual([expect.objectContaining({ id: 2, recording_type: 'inbound', duration_seconds: 118 })]);
    expect(body.data.events.map((event: { id: number }) => event.id)).toEqual([3, 5]);
    expect(body.data.events[0].data.instructions).toMatch(/… \(600 chars\)$/);
    expect(body.data.events_total).toBe(2);
    expect(body.data.events_note).toBeUndefined();
    expect(text).not.toContain(CONNECTION_KEY);
  });

  it('list_voice_chats filters by the agent and pages', async () => {
    seedCatalog();
    route('GET /api/realtime-agent-chats/', { status: 200, body: { count: 1, results: [{ id: 31, connection_key: CONNECTION_KEY, rt_agent_definition: 8, end_reason: '' }] } });

    const { body, text } = await call('list_voice_chats', { agent: 'Support', limit: 5 });

    const request = requests('GET', '/api/realtime-agent-chats/')[0]!;
    expect(request.query.get('rt_agent_definition')).toBe('8');
    expect(request.query.get('limit')).toBe('5');
    expect(body.data.chats[0]).toMatchObject({ id: 31, agent: { id: 8, name: 'Support' }, end_reason: null });
    expect(text).not.toContain(CONNECTION_KEY);
  });

  it('truncateStrings cuts long strings at any depth and keeps the rest', () => {
    expect(truncateStrings({ a: ['x'.repeat(501)], b: 1, c: null })).toEqual({ a: [`${'x'.repeat(500)}… (501 chars)`], b: 1, c: null });
  });
});
