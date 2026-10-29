import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AgentDefinitionsApi } from '../api/agent-definitions.js';
import { RealtimeAgentDefinitionsApi, activeVoiceProvider } from '../api/realtime-agent-definitions.js';
import {
  type CreateTwilioChannelRequest,
  type RealtimeChannel,
  RealtimeChannelsApi,
  TWILIO_ACCOUNT_SID_PATTERN,
  type TwilioPhoneNumber,
  type UpdateRealtimeChannelRequest,
  type UpdateTwilioChannelRequest,
} from '../api/realtime-channels.js';
import { SecretsApi } from '../api/secrets.js';
import { credentialEnvName } from '../flow-source/schema/common.js';
import { ApiError } from '../http/errors.js';
import { describeUser } from '../models/authorship.js';
import { runTool } from './auth-org.tools.js';
import { idOrName, recycleBinHint, resolveCredential, resolveNamedRef } from './catalog-helpers.js';

/**
 * Voice channels: a phone number (Twilio) whose inbound calls reach an agent's voice. A channel is
 * two backend rows — `realtime-channels/` (name, destination agent, enabled) and `twilio-channels/`
 * (account SID, the org Secret holding the Twilio auth token, phone number, webhook trigger) — saved
 * in that order, then the Twilio number's webhook is pointed at the channel, as the editor's
 * channel dialog does. The auth token comes from an environment variable of the MCP server or an
 * existing org Secret; the channel's routing token is never returned.
 */

const accountSidSchema = z
  .string()
  .regex(TWILIO_ACCOUNT_SID_PATTERN, 'a Twilio account SID is "AC" followed by 32 hex characters')
  .describe('Twilio account SID ("AC…", from the Twilio console).');

const authTokenEnvSchema = credentialEnvName(
  'Environment variable of the MCP server holding the Twilio auth token, stored as the org Secret ' +
    '"es-mcp:<ENV>" (reused while it holds that value). The token never appears in a tool call.',
);
const authTokenSecretSchema = idOrName.describe('An existing org Secret (list_secrets) holding the Twilio auth token: id or name.');

const phoneNumberSchema = z
  .string()
  .min(1)
  .max(32)
  .describe('Twilio phone number of the account in E.164 form, e.g. "+15551234567" (list_twilio_phone_numbers).');

const webhookTriggerSchema = z
  .number()
  .int()
  .describe(
    'Id of an existing public (ngrok) webhook trigger Twilio calls — a localhost trigger is refused. Without one, ' +
      'Twilio cannot reach the channel.',
  );

const AUTH_TOKEN_INPUTS = { env: 'auth_token_env', secret: 'auth_token_secret' };

export function registerVoiceChannelTools(server: McpServer, context: AppContext): void {
  const channels = new RealtimeChannelsApi(context.client);
  const agents = new AgentDefinitionsApi(context.client);
  const voiceSettings = new RealtimeAgentDefinitionsApi(context.client);
  // Built per call: registration must not touch context.auth (it throws when unconfigured).
  const secrets = (): SecretsApi => new SecretsApi(context.client, context.auth);

  const resolveChannel = (ref: number | string): Promise<number> =>
    resolveNamedRef(ref, 'Voice channel', () => channels.listChannels(), (channel) => channel.id, (channel) => channel.name);

  async function loadAgentNames(): Promise<Map<number, string>> {
    return new Map((await agents.list()).map((agent) => [agent.id, agent.name]));
  }

  /** The destination of a channel: an agent that has voice settings. Warns when its voice is off. */
  async function resolveVoiceAgent(ref: number | string, warnings: string[]): Promise<number> {
    const agentId = await resolveNamedRef(ref, 'Agent', () => agents.list(), (agent) => agent.id, (agent) => agent.name);
    const settings = await voiceSettings.getByAgentId(agentId);
    if (settings === null) {
      throw new Error(`Agent ${JSON.stringify(ref)} has no voice settings — give it a voice with set_agent_voice first.`);
    }
    if (activeVoiceProvider(settings) === null) {
      warnings.push('The agent\'s voice is switched off (no provider config): calls fail until set_agent_voice sets one.');
    }
    return agentId;
  }

  /**
   * Point the Twilio number at the channel (`twilio/configure-webhook/`). The phone SID comes from
   * the account's number list, as in the editor; a problem is a warning — the channel is saved.
   */
  async function configureWebhook(
    channel: RealtimeChannel,
    accountSid: string,
    authTokenSecretId: number,
    phoneNumber: string,
    warnings: string[],
  ): Promise<{ configured: boolean; webhook_url?: string }> {
    let numbers: TwilioPhoneNumber[];
    try {
      numbers = await channels.getPhoneNumbers(accountSid, authTokenSecretId);
    } catch (error) {
      warnings.push(`Could not read the Twilio account's numbers to configure the webhook: ${errorText(error)}`);
      return { configured: false };
    }
    const number = numbers.find((entry) => entry.phone_number === phoneNumber);
    if (number === undefined) {
      warnings.push(
        `The Twilio account has no number ${phoneNumber}, so its webhook was not configured. ` +
          `Numbers: ${numbers.map((entry) => entry.phone_number).join(', ') || '(none)'}.`,
      );
      return { configured: false };
    }
    try {
      const { webhook_url } = await channels.configureWebhook(number.sid, channel.token);
      return { configured: true, webhook_url: redactChannelToken(webhook_url) };
    } catch (error) {
      warnings.push(`The channel is saved, but configuring the Twilio webhook failed (check the tunnel): ${errorText(error)}`);
      return { configured: false };
    }
  }

  server.registerTool(
    'list_voice_channels',
    {
      title: 'List voice channels',
      description:
        'List the org\'s voice channels (phone numbers routed to an agent\'s voice): destination agent, enabled, ' +
        'Twilio account SID, phone number, whether an auth token is set, the webhook trigger and its public URL.',
      inputSchema: {
        agent: idOrName.optional().describe('Only channels routed to this agent: backend id or exact name.'),
      },
    },
    async ({ agent }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const [rows, agentNames] = await Promise.all([channels.listChannels(), loadAgentNames()]);
        const agentId =
          agent === undefined
            ? undefined
            : await resolveNamedRef(agent, 'Agent', async () => [...agentNames].map(([id, name]) => ({ id, name })), (row) => row.id, (row) => row.name);
        return rows
          .filter((channel) => agentId === undefined || channel.realtime_agent_definition === agentId)
          .map((channel) => describeChannel(channel, agentNames));
      }),
  );

  server.registerTool(
    'create_voice_channel',
    {
      title: 'Create a voice channel',
      description:
        'Route a Twilio phone number to an agent\'s voice (the agent needs voice settings — set_agent_voice). ' +
        'Saves the channel, then its Twilio settings, then (configure_webhook, default on) points the number\'s ' +
        'webhook at the channel when a phone_number and a public webhook_trigger are given. The auth token comes ' +
        'from auth_token_env (env var of the MCP server) or auth_token_secret — never inline.',
      inputSchema: {
        name: z.string().min(1).max(250).describe('Channel name.'),
        agent: idOrName.optional().describe('Agent whose voice answers the calls: backend id or exact name.'),
        enabled: z.boolean().default(true).describe('Whether the channel takes calls.'),
        account_sid: accountSidSchema,
        auth_token_env: authTokenEnvSchema.optional(),
        auth_token_secret: authTokenSecretSchema.optional(),
        phone_number: phoneNumberSchema.optional(),
        webhook_trigger: webhookTriggerSchema.optional(),
        configure_webhook: z
          .boolean()
          .default(true)
          .describe('Point the Twilio number\'s webhook at this channel (needs phone_number + webhook_trigger).'),
      },
    },
    async ({ name, agent, enabled, account_sid, auth_token_env, auth_token_secret, phone_number, webhook_trigger, configure_webhook }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const warnings: string[] = [];
        const agentId = agent === undefined ? null : await resolveVoiceAgent(agent, warnings);
        const authTokenSecretId = await resolveCredential(secrets, auth_token_env, auth_token_secret, AUTH_TOKEN_INPUTS);
        if (authTokenSecretId == null) throw new Error('Pass auth_token_env or auth_token_secret — Twilio needs the auth token.');

        const channel = await channels.createChannel({
          name,
          channel_type: 'twilio',
          realtime_agent_definition: agentId,
          is_enabled: enabled,
        });
        try {
          await channels.createTwilioChannel({
            channel: channel.id,
            account_sid,
            auth_token_secret_id: authTokenSecretId,
            phone_number: phone_number ?? null,
            webhook_trigger: webhook_trigger ?? null,
          });
        } catch (error) {
          throw new Error(
            `Voice channel "${name}" was created (id ${channel.id}) but its Twilio settings were refused: ${errorText(error)} ` +
              `Fix them with update_voice_channel(channel: ${channel.id}, …) or remove it with delete_voice_channel.`,
          );
        }
        const webhook =
          configure_webhook && phone_number !== undefined && webhook_trigger !== undefined
            ? await configureWebhook(channel, account_sid, authTokenSecretId, phone_number, warnings)
            : { configured: false };
        if (webhook_trigger === undefined) warnings.push('No webhook_trigger: Twilio cannot reach this channel until one is set.');
        const [saved, agentNames] = await Promise.all([channels.getChannel(channel.id), loadAgentNames()]);
        return {
          channel: describeChannel(saved, agentNames),
          webhook,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      }),
  );

  server.registerTool(
    'update_voice_channel',
    {
      title: 'Update a voice channel',
      description:
        'Change a voice channel (only what you pass): name, destination agent (null = none), enabled, and its ' +
        'Twilio settings. When a Twilio setting changes, the number\'s webhook is pointed at the channel again ' +
        '(configure_webhook, default on in that case).',
      inputSchema: {
        channel: idOrName.describe('The channel: backend id or exact name (list_voice_channels).'),
        name: z.string().min(1).max(250).optional(),
        agent: idOrName.nullable().optional().describe('Agent whose voice answers the calls; null removes the destination.'),
        enabled: z.boolean().optional(),
        account_sid: accountSidSchema.optional(),
        auth_token_env: authTokenEnvSchema.optional(),
        auth_token_secret: authTokenSecretSchema.optional(),
        phone_number: phoneNumberSchema.nullable().optional(),
        webhook_trigger: webhookTriggerSchema.nullable().optional(),
        configure_webhook: z
          .boolean()
          .optional()
          .describe('Point the number\'s webhook at the channel. Default: on when a Twilio setting changes.'),
      },
    },
    async ({ channel, name, agent, enabled, account_sid, auth_token_env, auth_token_secret, phone_number, webhook_trigger, configure_webhook }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const warnings: string[] = [];
        const channelId = await resolveChannel(channel);
        const current = await channels.getChannel(channelId);

        const channelRequest: UpdateRealtimeChannelRequest = {
          ...(name !== undefined ? { name } : {}),
          ...(enabled !== undefined ? { is_enabled: enabled } : {}),
          ...(agent !== undefined
            ? { realtime_agent_definition: agent === null ? null : await resolveVoiceAgent(agent, warnings) }
            : {}),
        };
        const authTokenSecretId = await resolveCredential(secrets, auth_token_env, auth_token_secret, AUTH_TOKEN_INPUTS);
        const twilioRequest: UpdateTwilioChannelRequest = {
          ...(account_sid !== undefined ? { account_sid } : {}),
          ...(authTokenSecretId != null ? { auth_token_secret_id: authTokenSecretId } : {}),
          ...(phone_number !== undefined ? { phone_number } : {}),
          ...(webhook_trigger !== undefined ? { webhook_trigger } : {}),
        };
        const twilioChanged = Object.keys(twilioRequest).length > 0;
        if (Object.keys(channelRequest).length === 0 && !twilioChanged && configure_webhook !== true) {
          throw new Error('Nothing to change — pass at least one field (or configure_webhook: true to re-point the number).');
        }

        // A channel without Twilio settings gets them created — checked before any write.
        let twilioCreate: CreateTwilioChannelRequest | undefined;
        if (twilioChanged && !current.twilio) {
          if (account_sid === undefined || authTokenSecretId == null) {
            throw new Error('The channel has no Twilio settings yet: pass account_sid and auth_token_env / auth_token_secret.');
          }
          twilioCreate = {
            channel: channelId,
            account_sid,
            auth_token_secret_id: authTokenSecretId,
            phone_number: phone_number ?? null,
            webhook_trigger: webhook_trigger ?? null,
          };
        }

        if (Object.keys(channelRequest).length > 0) await channels.updateChannel(channelId, channelRequest);
        if (twilioCreate) await channels.createTwilioChannel(twilioCreate);
        else if (twilioChanged) await channels.updateTwilioChannel(channelId, twilioRequest);

        const saved = await channels.getChannel(channelId);
        const twilio = saved.twilio;
        let webhook: { configured: boolean; webhook_url?: string } = { configured: false };
        if (configure_webhook ?? twilioChanged) {
          if (!twilio) {
            warnings.push('The webhook was not configured: the channel has no Twilio settings.');
          } else if (twilio.phone_number && twilio.webhook_trigger && twilio.auth_token_secret_id != null) {
            webhook = await configureWebhook(saved, twilio.account_sid, twilio.auth_token_secret_id, twilio.phone_number, warnings);
          } else {
            warnings.push('The webhook was not configured: the channel needs a phone number, a webhook trigger and an auth token.');
          }
        }
        return {
          channel: describeChannel(saved, await loadAgentNames()),
          webhook,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      }),
  );

  server.registerTool(
    'delete_voice_channel',
    {
      title: 'Delete a voice channel',
      description:
        'Delete a voice channel: it moves to the recycle bin (restorable with restore_from_recycle_bin kind ' +
        '"realtime_channel") and stops taking calls. The Twilio number keeps pointing at it until reconfigured.',
      inputSchema: {
        channel: idOrName.describe('The channel: backend id or exact name.'),
      },
    },
    async ({ channel }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        const channelId = await resolveChannel(channel);
        const current = await channels.getChannel(channelId);
        await channels.deleteChannel(channelId);
        return { deleted: { id: channelId, name: current.name }, next: recycleBinHint('realtime_channel', channelId) };
      }),
  );

  server.registerTool(
    'list_twilio_phone_numbers',
    {
      title: 'List Twilio phone numbers',
      description:
        'List the incoming phone numbers of a Twilio account (sid, number, friendly name, where its voice webhook ' +
        'points) — of an existing channel\'s account, or of account_sid with its auth token (auth_token_env stores ' +
        'the token as an org secret first).',
      inputSchema: {
        channel: idOrName.optional().describe('Use this channel\'s Twilio account: backend id or exact name.'),
        account_sid: accountSidSchema.optional(),
        auth_token_env: authTokenEnvSchema.optional(),
        auth_token_secret: authTokenSecretSchema.optional(),
      },
    },
    async ({ channel, account_sid, auth_token_env, auth_token_secret }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        await context.org.requireActiveOrg();
        let accountSid: string;
        let authTokenSecretId: number | null | undefined;
        if (channel !== undefined) {
          if (account_sid !== undefined || auth_token_env !== undefined || auth_token_secret !== undefined) {
            throw new Error('Pass either channel or account_sid + auth token, not both.');
          }
          const twilio = (await channels.getChannel(await resolveChannel(channel))).twilio;
          if (!twilio) throw new Error('That channel has no Twilio settings.');
          accountSid = twilio.account_sid;
          authTokenSecretId = twilio.auth_token_secret_id;
        } else {
          if (account_sid === undefined) throw new Error('Pass channel, or account_sid with auth_token_env / auth_token_secret.');
          accountSid = account_sid;
          authTokenSecretId = await resolveCredential(secrets, auth_token_env, auth_token_secret, AUTH_TOKEN_INPUTS);
        }
        if (authTokenSecretId == null) throw new Error('No Twilio auth token: pass auth_token_env or auth_token_secret.');
        const [numbers, orgChannels] = await Promise.all([
          channels.getPhoneNumbers(accountSid, authTokenSecretId),
          channels.listChannels(),
        ]);
        const channelByToken = new Map(orgChannels.map((row) => [row.token.toLowerCase(), row]));
        return {
          account_sid: accountSid,
          numbers: numbers.map((number) => {
            const routed = number.voice_url ? channelByToken.get(channelTokenOf(number.voice_url) ?? '') : undefined;
            return {
              sid: number.sid,
              phone_number: number.phone_number,
              friendly_name: number.friendly_name,
              voice_url: number.voice_url === null ? null : redactChannelToken(number.voice_url),
              routed_to_channel: routed ? { id: routed.id, name: routed.name } : null,
            };
          }),
        };
      }),
  );
}

/** A channel as tool output — never its routing token; the auth token only as a presence flag. */
function describeChannel(channel: RealtimeChannel, agentNames: Map<number, string>): Record<string, unknown> {
  const twilio = channel.twilio;
  const trigger = twilio?.webhook_trigger ?? null;
  return {
    id: channel.id,
    name: channel.name,
    channel_type: channel.channel_type,
    enabled: channel.is_enabled,
    agent:
      channel.realtime_agent_definition === null
        ? null
        : { id: channel.realtime_agent_definition, name: agentNames.get(channel.realtime_agent_definition) ?? null },
    ...(channel.realtime_agent !== null
      ? {
          legacy_realtime_agent: channel.realtime_agent,
          legacy_note: 'Still routed to a removed staff agent: set agent (update_voice_channel) to repair it.',
        }
      : {}),
    twilio: twilio
      ? {
          account_sid: twilio.account_sid,
          phone_number: twilio.phone_number,
          has_auth_token: twilio.auth_token_secret_id != null,
          webhook_trigger: trigger
            ? {
                id: trigger.id ?? null,
                path: trigger.path,
                provider_type: trigger.provider_type,
                live_url: trigger.live_url ?? null,
              }
            : null,
        }
      : null,
    created_by: describeUser(channel.created_by),
    created_at: channel.created_at,
    last_edited_by: describeUser(channel.last_edited_by),
    last_edited_at: channel.last_edited_at ?? null,
  };
}

/** `…/voice/<token>` — the path a Twilio number's voice webhook calls (TwilioService.configure_webhook). */
const VOICE_WEBHOOK_TOKEN = /\/voice\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function channelTokenOf(url: string): string | undefined {
  return VOICE_WEBHOOK_TOKEN.exec(url)?.[1]?.toLowerCase();
}

/** A voice webhook URL with the channel's routing token masked — tool output never carries it. */
function redactChannelToken(url: string): string {
  return url.replace(VOICE_WEBHOOK_TOKEN, '/voice/<channel token>');
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    // A decoded validation error already names its fields in the message; otherwise show the body.
    return error.validationErrors?.length ? error.message : `${error.message}${error.bodyExcerpt ? ` — ${error.bodyExcerpt}` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}
