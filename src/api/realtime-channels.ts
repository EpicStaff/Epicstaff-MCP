import type { ApiClient } from '../http/client.js';
import type { AuthorshipFields } from '../models/authorship.js';
import type { WebhookTriggerModel } from '../models/nodes/webhook-trigger-node.js';
import { type Paginated, unwrap } from './paging.js';

/**
 * Voice channels — ported from frontend shared/services/realtime-channel.service.ts and
 * shared/models/realtime-voice/realtime-channel.model.ts.
 *
 * A `realtime-channels/` row routes inbound phone calls to an agent's voice settings
 * (`realtime_agent_definition`); its Twilio half lives in `twilio-channels/` (keyed by the channel
 * id): the account SID, the org Secret holding the Twilio auth token, the phone number and the
 * webhook trigger whose public URL Twilio calls. Deleting a channel moves it to the recycle bin.
 */
export interface TwilioChannel {
  channel: number;
  account_sid: string;
  auth_token_secret_id: number | null;
  phone_number: string | null;
  /** Expanded on read (_TwilioChannelReadSerializer); written as a bare webhook-trigger id. */
  webhook_trigger: WebhookTriggerModel | null;
}

export interface RealtimeChannel extends Partial<AuthorshipFields> {
  id: number;
  name: string;
  channel_type: 'twilio';
  /** Routing key Twilio's webhook URL carries (`/voice/<token>`). */
  token: string;
  /** Legacy staff destination — read-only; the supported destination is realtime_agent_definition. */
  realtime_agent: number | null;
  realtime_agent_definition: number | null;
  is_enabled: boolean;
  twilio?: TwilioChannel | null;
  created_at: string | null;
}

export interface CreateRealtimeChannelRequest {
  name: string;
  channel_type: 'twilio';
  realtime_agent_definition?: number | null;
  is_enabled?: boolean;
}

export interface UpdateRealtimeChannelRequest {
  name?: string;
  realtime_agent_definition?: number | null;
  is_enabled?: boolean;
}

export interface CreateTwilioChannelRequest {
  channel: number;
  account_sid: string;
  /**
   * Required and non-null on write (TwilioChannelSerializer: required=True, allow_null=False) —
   * narrower than the frontend's `number | null`, which the backend would refuse anyway.
   */
  auth_token_secret_id: number;
  phone_number?: string | null;
  webhook_trigger?: number | null;
}

export type UpdateTwilioChannelRequest = Partial<Omit<CreateTwilioChannelRequest, 'channel'>>;

/** One incoming number of a Twilio account (`twilio-channels/phone-numbers/`). */
export interface TwilioPhoneNumber {
  sid: string;
  phone_number: string;
  friendly_name: string;
  voice_url: string | null;
}

/** Mirrors `_TWILIO_ACCOUNT_SID_RE` in tables/services/twilio_service.py. */
export const TWILIO_ACCOUNT_SID_PATTERN = /^AC[0-9a-fA-F]{32}$/;

export class RealtimeChannelsApi {
  constructor(private readonly client: ApiClient) {}

  async listChannels(): Promise<RealtimeChannel[]> {
    return unwrap(
      await this.client.get<Paginated<RealtimeChannel> | RealtimeChannel[]>('realtime-channels/', { query: { limit: 1000 } }),
    );
  }

  async getChannel(id: number): Promise<RealtimeChannel> {
    return this.client.get<RealtimeChannel>(`realtime-channels/${id}/`);
  }

  async createChannel(request: CreateRealtimeChannelRequest): Promise<RealtimeChannel> {
    return this.client.post('realtime-channels/', { body: request });
  }

  async updateChannel(id: number, request: UpdateRealtimeChannelRequest): Promise<RealtimeChannel> {
    return this.client.patch(`realtime-channels/${id}/`, { body: request });
  }

  /** Moves the channel to the recycle bin (RecycleBinActionsMixin). */
  async deleteChannel(id: number): Promise<void> {
    await this.client.delete<void>(`realtime-channels/${id}/`);
  }

  /** The backend upserts by `channel`: an existing Twilio row of that channel is updated (200). */
  async createTwilioChannel(request: CreateTwilioChannelRequest): Promise<TwilioChannel> {
    return this.client.post('twilio-channels/', { body: request });
  }

  async updateTwilioChannel(channelId: number, request: UpdateTwilioChannelRequest): Promise<TwilioChannel> {
    return this.client.patch(`twilio-channels/${channelId}/`, { body: request });
  }

  /** The incoming numbers of the Twilio account `sid`, read with the auth token held by the given secret. */
  async getPhoneNumbers(sid: string, authTokenSecretId: number): Promise<TwilioPhoneNumber[]> {
    const response = await this.client.get<{ results: TwilioPhoneNumber[] }>('twilio-channels/phone-numbers/', {
      query: { sid, auth_token_secret_id: authTokenSecretId },
    });
    return response.results;
  }

  /** Point the Twilio number's VoiceUrl at the channel (needs a non-localhost webhook trigger). */
  async configureWebhook(phoneSid: string, channelToken: string): Promise<{ webhook_url: string }> {
    return this.client.post('twilio/configure-webhook/', { body: { phone_sid: phoneSid, channel_token: channelToken } });
  }
}
