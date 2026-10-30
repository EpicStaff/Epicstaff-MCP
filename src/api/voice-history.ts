import type { ApiClient } from '../http/client.js';
import type { UserSummary } from '../models/authorship.js';
import type { Paginated } from './paging.js';

/**
 * Voice conversation history — ported from the backend (the frontend has no service for it):
 * RealtimeAgentChatViewSet, ConversationRecordingViewSet and RealtimeSessionItemViewSet in
 * src/django_app/tables/views/model_view_sets.py with their serializers in
 * tables/serializers/model_serializers/realtime_serializers.py.
 *
 * A chat is one voice session of an agent, scoped to the org through the agent's voice settings
 * (a chat whose settings were deleted is no longer visible). Recordings are the call audio the
 * realtime service uploads when a call ends; session items are the raw provider events it logged,
 * keyed by the chat's `connection_key` (audio redacted unless the deployment persists raw audio).
 */
export type RealtimeAgentChatEndReason = 'completed' | 'error' | 'cancelled' | 'timeout';

export interface RealtimeAgentChat {
  id: number;
  /** Opaque key of the realtime session — internal; MCP never returns it. */
  connection_key: string;
  created_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  end_reason: RealtimeAgentChatEndReason | '' | null;
  wake_word: string | null;
  stop_prompt: string | null;
  voice: string;
  language: string | null;
  voice_recognition_prompt: string | null;
  input_audio_format: string;
  output_audio_format: string;
  rt_agent: number | null;
  /** The agent definition id whose voice settings ran the chat. */
  rt_agent_definition: number | null;
  openai_config: number | null;
  elevenlabs_config: number | null;
  gemini_config: number | null;
}

export interface ConversationRecording {
  id: number;
  /** URL of the audio file. */
  file: string;
  recording_type: 'inbound' | 'outbound';
  audio_format: string;
  duration_seconds: number | null;
  file_size: number | null;
  created_at: string;
  rt_agent_chat: number | null;
}

export interface RealtimeSessionItem {
  id: number;
  connection_key: string;
  data: unknown;
  created_at: string;
  org?: number | null;
  created_by?: UserSummary | null;
}

/** Largest page MCP asks for when it scans session items (the list has no filter). */
export const SESSION_ITEM_PAGE_SIZE = 1000;

export class VoiceHistoryApi {
  constructor(private readonly client: ApiClient) {}

  async listChats(options: { agentId?: number; limit: number; offset: number }): Promise<Paginated<RealtimeAgentChat>> {
    return this.client.get<Paginated<RealtimeAgentChat>>('realtime-agent-chats/', {
      query: {
        limit: options.limit,
        offset: options.offset,
        ...(options.agentId !== undefined ? { rt_agent_definition: options.agentId } : {}),
      },
    });
  }

  async getChat(id: number): Promise<RealtimeAgentChat> {
    return this.client.get<RealtimeAgentChat>(`realtime-agent-chats/${id}/`);
  }

  /** Deletes the chat for good, its recordings with it (no recycle bin). */
  async deleteChat(id: number): Promise<void> {
    await this.client.delete<void>(`realtime-agent-chats/${id}/`);
  }

  async listRecordings(chatId: number): Promise<ConversationRecording[]> {
    const page = await this.client.get<Paginated<ConversationRecording>>('conversation-recordings/', {
      query: { rt_agent_chat: chatId, limit: 100 },
    });
    return page.results;
  }

  /** One page of the org's session items, in backend order — the endpoint offers no filter. */
  async listSessionItems(limit: number, offset: number): Promise<Paginated<RealtimeSessionItem>> {
    return this.client.get<Paginated<RealtimeSessionItem>>('realtime-session-items/', { query: { limit, offset } });
  }
}
