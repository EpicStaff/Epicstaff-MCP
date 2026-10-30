import type { ApiClient } from '../http/client.js';
import { ApiError } from '../http/errors.js';
import { type Paginated, unwrap } from './paging.js';
import type { VoiceProvider } from './voice-configs.js';

/**
 * An agent's voice settings — ported from frontend
 * features/agent-definitions/services/realtime-agent-definitions-api.service.ts and
 * models/realtime-agent-definition.model.ts.
 *
 * One-to-one with an AgentDefinition: the primary key IS the agent definition id. A row with a
 * provider config set = the agent can hold voice conversations (the Chats page lists it, a voice
 * channel can route calls to it); at most one of the three provider configs may be set.
 */
export interface RealtimeAgentDefinition {
  agent_definition: number;
  openai_config: number | null;
  elevenlabs_config: number | null;
  gemini_config: number | null;
  voice: string;
  wake_word: string | null;
  stop_prompt: string | null;
  /** ISO-639-1 code ("en"); blank is stored as null. */
  language: string | null;
  voice_recognition_prompt: string | null;
}

export interface CreateRealtimeAgentDefinitionRequest {
  agent_definition: number;
  openai_config?: number | null;
  elevenlabs_config?: number | null;
  gemini_config?: number | null;
  voice?: string;
  wake_word?: string | null;
  stop_prompt?: string | null;
  language?: string | null;
  voice_recognition_prompt?: string | null;
}

export type PartialUpdateRealtimeAgentDefinitionRequest = Partial<CreateRealtimeAgentDefinitionRequest>;

/** The provider whose config is set on a voice row, with that config's id (chatAgentRealtimeConfigId). */
export function activeVoiceProvider(
  row: Pick<RealtimeAgentDefinition, 'openai_config' | 'elevenlabs_config' | 'gemini_config'>,
): { provider: VoiceProvider; configId: number } | null {
  if (row.openai_config != null) return { provider: 'openai', configId: row.openai_config };
  if (row.elevenlabs_config != null) return { provider: 'elevenlabs', configId: row.elevenlabs_config };
  if (row.gemini_config != null) return { provider: 'gemini', configId: row.gemini_config };
  return null;
}

export class RealtimeAgentDefinitionsApi {
  constructor(private readonly client: ApiClient) {}

  async list(): Promise<RealtimeAgentDefinition[]> {
    return unwrap(
      await this.client.get<Paginated<RealtimeAgentDefinition> | RealtimeAgentDefinition[]>('realtime-agent-definitions/', {
        query: { limit: 1000 },
      }),
    );
  }

  /** 404 = no row = voice was never set up for the agent → null. Other errors propagate. */
  async getByAgentId(agentId: number): Promise<RealtimeAgentDefinition | null> {
    try {
      return await this.client.get<RealtimeAgentDefinition>(`realtime-agent-definitions/${agentId}/`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async create(request: CreateRealtimeAgentDefinitionRequest): Promise<RealtimeAgentDefinition> {
    return this.client.post('realtime-agent-definitions/', { body: request });
  }

  async partialUpdate(
    agentId: number,
    request: PartialUpdateRealtimeAgentDefinitionRequest,
  ): Promise<RealtimeAgentDefinition> {
    return this.client.patch(`realtime-agent-definitions/${agentId}/`, { body: request });
  }

  /** Deletes the row for good (it has no recycle bin). */
  async delete(agentId: number): Promise<void> {
    await this.client.delete<void>(`realtime-agent-definitions/${agentId}/`);
  }
}
