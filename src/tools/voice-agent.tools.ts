import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AgentDefinitionsApi } from '../api/agent-definitions.js';
import {
  type PartialUpdateRealtimeAgentDefinitionRequest,
  type RealtimeAgentDefinition,
  RealtimeAgentDefinitionsApi,
  activeVoiceProvider,
} from '../api/realtime-agent-definitions.js';
import { RealtimeChannelsApi } from '../api/realtime-channels.js';
import { VOICE_PROVIDERS, VoiceConfigsApi, type VoiceProvider } from '../api/voice-configs.js';
import {
  type RealtimeAgentChat,
  type RealtimeSessionItem,
  SESSION_ITEM_PAGE_SIZE,
  VoiceHistoryApi,
} from '../api/voice-history.js';
import { runTool } from './auth-org.tools.js';
import { idOrName, pickDefined, resolveNamedRef } from './catalog-helpers.js';
import { voiceProviderSchema } from './voice-config.tools.js';

/**
 * An agent's voice: its voice settings (`realtime-agent-definitions/`, one row per AgentDefinition —
 * provider config, voice, wake / stop words, language, transcription hint) and the history of its
 * voice conversations (chats, their call recordings and the provider events the realtime service
 * logged). Talking to the agent happens in the EpicStaff Chats page or over a phone channel
 * (create_voice_channel) — a live audio session is not something an MCP tool can hold.
 */

/** Backend default of `voice` (RealtimeAgentDefinition.voice). */
const DEFAULT_VOICE = 'alloy';

/** Mirrors the backend language validator (RealtimeAgentDefinitionSerializer). */
const LANGUAGE_PATTERN = /^[a-z]{2}$/;

/** Session items are scanned page by page (the list has no filter); this many pages at most. */
const MAX_SESSION_ITEM_PAGES = 10;

/** Event strings longer than this are cut in tool output. */
const EVENT_STRING_LIMIT = 500;

type ConfigNames = Record<VoiceProvider, Map<number, string>>;

export function registerVoiceAgentTools(server: McpServer, context: AppContext): void {
  const agents = new AgentDefinitionsApi(context.client);
  const voiceSettings = new RealtimeAgentDefinitionsApi(context.client);
  const voiceConfigs = new VoiceConfigsApi(context.client);
  const channels = new RealtimeChannelsApi(context.client);
  const history = new VoiceHistoryApi(context.client);

  const resolveAgent = (ref: number | string): Promise<number> =>
    resolveNamedRef(ref, 'Agent', () => agents.list(), (agent) => agent.id, (agent) => agent.name);

  async function loadConfigNames(): Promise<ConfigNames> {
    const [openai, elevenlabs, gemini] = await Promise.all(VOICE_PROVIDERS.map((provider) => voiceConfigs.listConfigs(provider)));
    const names = (rows: Array<{ id: number; custom_name: string }> | undefined) =>
      new Map((rows ?? []).map((row) => [row.id, row.custom_name]));
    return { openai: names(openai), elevenlabs: names(elevenlabs), gemini: names(gemini) };
  }

  async function loadAgentNames(): Promise<Map<number, string>> {
    return new Map((await agents.list()).map((agent) => [agent.id, agent.name]));
  }

  // ----- Voice settings ------------------------------------------------------------

  server.registerTool(
    'list_voice_agents',
    {
      title: 'List agents with voice settings',
      description:
        'List the agents that have voice settings: provider + voice config, voice, wake / stop word, language, ' +
        'transcription hint. enabled = a provider config is set (the agent appears in the Chats page and can take ' +
        'calls). Pass agent to read one agent\'s settings ({enabled: false, configured: false} when it has none).',
      inputSchema: {
        agent: idOrName.optional().describe('Only this agent: backend id or exact name.'),
      },
    },
    async ({ agent }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const [agentNames, configNames] = await Promise.all([loadAgentNames(), loadConfigNames()]);
        if (agent !== undefined) {
          const agentId = await resolveAgent(agent);
          const row = await voiceSettings.getByAgentId(agentId);
          if (row === null) {
            return { agent: { id: agentId, name: agentNames.get(agentId) ?? null }, configured: false, enabled: false };
          }
          return { configured: true, ...describeVoiceSettings(row, agentNames, configNames) };
        }
        return (await voiceSettings.list()).map((row) => describeVoiceSettings(row, agentNames, configNames));
      }),
  );

  server.registerTool(
    'set_agent_voice',
    {
      title: 'Set an agent\'s voice settings',
      description:
        'Give an agent a voice, or change its voice settings (creates them on first use, else PATCHes only what you ' +
        'pass). provider + config pick the voice config (list_voice_configs); provider: null switches voice off but ' +
        'keeps the settings and chat history. OpenAI / Gemini voices must be one of the provider\'s voices ' +
        '(list_voice_configs include_voices); an ElevenLabs voice is a free-form voice id. The agent\'s ' +
        'instructions, LLM and surfaces are its own (update_agent).',
      inputSchema: {
        agent: idOrName.describe('The agent: backend id or exact name.'),
        provider: voiceProviderSchema
          .nullable()
          .optional()
          .describe('Provider of the voice config; null switches voice off. Omit to keep the current one.'),
        config: idOrName.optional().describe('The provider\'s voice config: id or exact name. Required with provider.'),
        voice: z.string().max(100).optional().describe('Voice id, e.g. "alloy" (OpenAI), "Puck" (Gemini).'),
        wake_word: z.string().max(255).nullable().optional().describe('Word that wakes the agent (default: its name).'),
        stop_prompt: z.string().max(255).nullable().optional().describe('Word that ends the conversation (default "stop").'),
        language: z
          .string()
          .regex(LANGUAGE_PATTERN, 'language must be a lowercase ISO-639-1 code, e.g. "en"')
          .nullable()
          .optional()
          .describe('ISO-639-1 code the agent expects, e.g. "en"; null clears it.'),
        voice_recognition_prompt: z
          .string()
          .nullable()
          .optional()
          .describe('Hint that guides transcription, e.g. "Expect product names like Nimbus".'),
      },
    },
    async ({ agent, provider, config, ...fields }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        if (provider == null && config !== undefined) throw new Error('config needs provider (openai, elevenlabs or gemini).');
        if (provider != null && config === undefined) throw new Error(`Pass config: the ${provider} voice config to use.`);
        const agentId = await resolveAgent(agent);
        const existing = await voiceSettings.getByAgentId(agentId);
        const previousProvider = existing ? (activeVoiceProvider(existing)?.provider ?? null) : null;

        const request: PartialUpdateRealtimeAgentDefinitionRequest = pickDefined(fields);
        if (provider !== undefined) {
          let configId: number | null = null;
          if (provider !== null && config !== undefined) {
            configId = await resolveNamedRef(
              config,
              `${provider} voice config`,
              () => voiceConfigs.listConfigs(provider),
              (row) => row.id,
              (row) => row.custom_name,
            );
          }
          // The agent settings dialog writes all three: only the chosen provider's config is kept.
          request.openai_config = provider === 'openai' ? configId : null;
          request.elevenlabs_config = provider === 'elevenlabs' ? configId : null;
          request.gemini_config = provider === 'gemini' ? configId : null;
        }

        const nextProvider = provider !== undefined ? provider : previousProvider;
        if (fields.voice !== undefined || provider !== undefined) {
          await assertVoiceFits(voiceConfigs, nextProvider, previousProvider, fields.voice, existing?.voice ?? DEFAULT_VOICE);
        }

        if (existing === null && provider === null) {
          return {
            agent: { id: agentId },
            configured: false,
            enabled: false,
            note: 'The agent has no voice settings — there was nothing to switch off.',
          };
        }
        if (Object.keys(request).length === 0) throw new Error('Nothing to change — pass provider + config or a setting.');

        const saved =
          existing === null
            ? await voiceSettings.create({ agent_definition: agentId, ...request })
            : await voiceSettings.partialUpdate(agentId, request);
        const [agentNames, configNames] = await Promise.all([loadAgentNames(), loadConfigNames()]);
        const settings = describeVoiceSettings(saved, agentNames, configNames);
        return {
          ...(existing === null ? { created: true } : {}),
          voice_settings: settings,
          next: settings.enabled
            ? 'Talk to it in the EpicStaff Chats page, or route a phone number to it with create_voice_channel.'
            : 'Voice is off: pick provider + config to switch it on.',
        };
      }),
  );

  server.registerTool(
    'delete_agent_voice',
    {
      title: 'Delete an agent\'s voice settings',
      description:
        'Delete an agent\'s voice settings FOR GOOD (no recycle bin). Its voice chats are no longer listed (they are ' +
        'scoped through these settings) and voice channels routed to it lose their destination. To only switch voice ' +
        'off, use set_agent_voice(provider: null).',
      inputSchema: {
        agent: idOrName.describe('The agent: backend id or exact name.'),
      },
    },
    async ({ agent }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const agentId = await resolveAgent(agent);
        if ((await voiceSettings.getByAgentId(agentId)) === null) {
          throw new Error(`Agent ${agentId} has no voice settings — nothing to delete.`);
        }
        const routedChannels = (await channels.listChannels()).filter(
          (channel) => channel.realtime_agent_definition === agentId,
        );
        await voiceSettings.delete(agentId);
        return {
          deleted: { agent: agentId },
          ...(routedChannels.length > 0
            ? {
                channels_without_destination: routedChannels.map((channel) => ({ id: channel.id, name: channel.name })),
                next: 'Point those channels at another agent with update_voice_channel(agent: …), or delete them.',
              }
            : {}),
        };
      }),
  );

  // ----- Voice conversation history --------------------------------------------------------

  server.registerTool(
    'list_voice_chats',
    {
      title: 'List voice chats',
      description:
        'List voice conversations (Chats page sessions and phone calls) of the org, or of one agent: when they ' +
        'started and ended, why they ended, the provider config and voice used. get_voice_chat shows one with its ' +
        'recordings and logged events.',
      inputSchema: {
        agent: idOrName.optional().describe('Only this agent\'s chats: backend id or exact name.'),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ agent, limit, offset }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const agentId = agent === undefined ? undefined : await resolveAgent(agent);
        const [page, agentNames] = await Promise.all([
          history.listChats({ ...(agentId !== undefined ? { agentId } : {}), limit, offset }),
          loadAgentNames(),
        ]);
        return { count: page.count, offset, chats: page.results.map((chat) => describeChat(chat, agentNames)) };
      }),
  );

  server.registerTool(
    'get_voice_chat',
    {
      title: 'Get a voice chat',
      description:
        'One voice conversation: timing, end reason, settings snapshot, its call recordings (inbound = caller, ' +
        'outbound = agent; file URL, duration, size) and — with include_events — the provider events the realtime ' +
        'service logged for it (transcripts, tool calls; audio is redacted unless the deployment keeps it, long ' +
        'strings are cut). Events are found by scanning the org\'s event log, so include_events is slower.',
      inputSchema: {
        chat: z.number().int().describe('Chat id (list_voice_chats).'),
        include_events: z.boolean().default(false).describe('Also return the logged provider events of the chat.'),
        event_limit: z.number().int().min(1).max(500).default(100).describe('Max events returned (oldest first).'),
      },
    },
    async ({ chat, include_events, event_limit }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const [row, recordings, agentNames] = await Promise.all([
          history.getChat(chat),
          history.listRecordings(chat),
          loadAgentNames(),
        ]);
        const result: Record<string, unknown> = {
          chat: describeChat(row, agentNames),
          recordings: recordings.map((recording) => ({
            id: recording.id,
            recording_type: recording.recording_type,
            audio_format: recording.audio_format,
            duration_seconds: recording.duration_seconds,
            file_size: recording.file_size,
            created_at: recording.created_at,
            file: recording.file,
          })),
        };
        if (include_events) {
          const scan = await collectSessionItems(history, row.connection_key);
          const events = scan.items.sort((left, right) => left.id - right.id);
          result.events = events.slice(0, event_limit).map((item) => ({
            id: item.id,
            created_at: item.created_at,
            type: eventType(item.data),
            data: truncateStrings(item.data),
          }));
          result.events_total = events.length;
          if (!scan.complete) {
            result.events_note =
              `Scanned the first ${scan.scanned} logged events of the organization; the chat may have more.`;
          }
        }
        return result;
      }),
  );

  server.registerTool(
    'delete_voice_chat',
    {
      title: 'Delete a voice chat',
      description: 'Delete one voice conversation and its call recordings FOR GOOD (no recycle bin).',
      inputSchema: {
        chat: z.number().int().describe('Chat id (list_voice_chats).'),
      },
    },
    async ({ chat }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const row = await history.getChat(chat);
        await history.deleteChat(chat);
        return { deleted: { id: row.id, agent: row.rt_agent_definition, created_at: row.created_at } };
      }),
  );
}

/** Voice settings as tool output: the active provider and its config named. */
function describeVoiceSettings(
  row: RealtimeAgentDefinition,
  agentNames: Map<number, string>,
  configNames: ConfigNames,
) {
  const active = activeVoiceProvider(row);
  return {
    agent: { id: row.agent_definition, name: agentNames.get(row.agent_definition) ?? null },
    enabled: active !== null,
    provider: active?.provider ?? null,
    config: active ? { id: active.configId, name: configNames[active.provider].get(active.configId) ?? null } : null,
    voice: row.voice,
    wake_word: row.wake_word,
    stop_prompt: row.stop_prompt,
    language: row.language,
    voice_recognition_prompt: row.voice_recognition_prompt,
  };
}

/**
 * Refuse a voice the provider does not offer. The agent settings dialog offers OpenAI / Gemini voices
 * as a fixed list (realtime-voices/) and clears the voice when ElevenLabs is picked; the backend checks
 * neither, so a stale "alloy" would otherwise reach Gemini or ElevenLabs.
 */
async function assertVoiceFits(
  voiceConfigs: VoiceConfigsApi,
  provider: VoiceProvider | null,
  previousProvider: VoiceProvider | null,
  requestedVoice: string | undefined,
  currentVoice: string,
): Promise<void> {
  if (provider === null) return;
  if (provider === 'elevenlabs') {
    if (requestedVoice === undefined && previousProvider !== 'elevenlabs') {
      throw new Error('ElevenLabs takes a free-form voice id from your ElevenLabs voice library — pass voice.');
    }
    return;
  }
  const offered = (await voiceConfigs.getVoices())[provider];
  if (offered === undefined || offered.length === 0) return;
  const voice = requestedVoice ?? currentVoice;
  if (!offered.some((entry) => entry.id === voice)) {
    throw new Error(
      `${provider} has no voice "${voice}"${requestedVoice === undefined ? ' (the current voice)' : ''}. ` +
        `Pass voice: one of ${offered.map((entry) => entry.id).join(', ')}.`,
    );
  }
}

/** A chat as tool output — never its connection key (the realtime session's handle). */
function describeChat(chat: RealtimeAgentChat, agentNames: Map<number, string>) {
  const active = activeVoiceProvider(chat);
  return {
    id: chat.id,
    agent:
      chat.rt_agent_definition === null
        ? null
        : { id: chat.rt_agent_definition, name: agentNames.get(chat.rt_agent_definition) ?? null },
    provider: active?.provider ?? null,
    config_id: active?.configId ?? null,
    voice: chat.voice,
    language: chat.language,
    created_at: chat.created_at,
    ended_at: chat.ended_at,
    duration_seconds: chat.duration_seconds,
    end_reason: chat.end_reason || null,
  };
}

/** The session items logged under `connectionKey`, scanning at most {@link MAX_SESSION_ITEM_PAGES} pages. */
async function collectSessionItems(
  history: VoiceHistoryApi,
  connectionKey: string,
): Promise<{ items: RealtimeSessionItem[]; scanned: number; complete: boolean }> {
  const items: RealtimeSessionItem[] = [];
  let scanned = 0;
  for (let page = 0; page < MAX_SESSION_ITEM_PAGES; page += 1) {
    const response = await history.listSessionItems(SESSION_ITEM_PAGE_SIZE, scanned);
    scanned += response.results.length;
    items.push(...response.results.filter((item) => item.connection_key === connectionKey));
    if (response.results.length === 0 || scanned >= response.count) return { items, scanned, complete: true };
  }
  return { items, scanned, complete: false };
}

function eventType(data: unknown): string | null {
  if (typeof data === 'object' && data !== null && 'type' in data) {
    const type = (data as { type: unknown }).type;
    return typeof type === 'string' ? type : null;
  }
  return null;
}

/** Copy of `value` with every string longer than {@link EVENT_STRING_LIMIT} cut (base64 audio, long prompts). */
export function truncateStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > EVENT_STRING_LIMIT
      ? `${value.slice(0, EVENT_STRING_LIMIT)}… (${value.length} chars)`
      : value;
  }
  if (Array.isArray(value)) return value.map(truncateStrings);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, truncateStrings(entry)]));
  }
  return value;
}
