import type { EpicStaffClient } from '../http/client.js';

/**
 * AgentDefinition API — the NEW first-class Agent entity (CrewAI-replacement model).
 * Ported from features/agent-definitions/services/agent-definitions-api.service.ts
 * and models/agent-definition.model.ts. Not the legacy /agents/ CrewAI agent.
 */
export type AgentSurfacePlace = 'all' | 'flow' | 'chat';

export interface AgentDefaultSurface {
  surface: number;
  place: AgentSurfacePlace;
}

export interface AgentDefinition {
  id: number;
  organization: number;
  name: string;
  description: string;
  instructions: string;
  llm_config: number | null;
  fcm_llm_config: number | null;
  default_surfaces: AgentDefaultSurface[];
  metadata: Record<string, unknown>;
  max_iter: number;
  max_rpm: number;
  max_execution_time: number;
  cache: boolean;
  max_retry_limit: number;
  default_temperature: number;
}

export interface CreateAgentDefinitionRequest {
  name: string;
  instructions: string;
  description?: string;
  llm_config?: number | null;
  fcm_llm_config?: number | null;
  default_surfaces?: AgentDefaultSurface[];
  metadata?: Record<string, unknown>;
  max_iter?: number;
  max_rpm?: number;
  max_execution_time?: number;
  cache?: boolean;
  max_retry_limit?: number;
  default_temperature?: number;
}

interface Paginated<T> {
  count: number;
  results: T[];
}

function unwrap<T>(response: Paginated<T> | T[]): T[] {
  return Array.isArray(response) ? response : response.results;
}

export class AgentDefinitionsApi {
  constructor(private readonly client: EpicStaffClient) {}

  async list(): Promise<AgentDefinition[]> {
    return unwrap(
      await this.client.get<Paginated<AgentDefinition> | AgentDefinition[]>('agent-definitions/', {
        query: { limit: 1000 },
      }),
    );
  }

  async get(id: number): Promise<AgentDefinition> {
    return this.client.get(`agent-definitions/${id}/`);
  }

  async create(request: CreateAgentDefinitionRequest): Promise<AgentDefinition> {
    return this.client.post('agent-definitions/', { body: request });
  }

  async update(id: number, request: Partial<CreateAgentDefinitionRequest>): Promise<AgentDefinition> {
    return this.client.patch(`agent-definitions/${id}/`, { body: request });
  }
}
