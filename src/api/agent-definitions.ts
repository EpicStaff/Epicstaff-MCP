import type { ApiClient } from '../http/client.js';
import type { AuthorshipFields } from '../models/authorship.js';

/**
 * AgentDefinition API — the NEW first-class Agent entity (CrewAI-replacement model).
 * Ported from features/agent-definitions/services/agent-definitions-api.service.ts,
 * models/agent-definition.model.ts and utils/instructions-file.utils.ts (instruction
 * naming). Not the legacy /agents/ CrewAI agent.
 */
export type AgentSurfacePlace = 'all' | 'flow' | 'chat';

export interface AgentDefaultSurface {
  surface: number;
  place: AgentSurfacePlace;
}

/** One named instruction document. List order = the order the agent reads them in. */
export interface AgentInstruction {
  name: string;
  content: string;
}

export interface AgentDefinition extends AuthorshipFields {
  id: number;
  org: number;
  name: string;
  description: string;
  instruction_list: AgentInstruction[];
  /** Read-only: every `instruction_list` content joined by a blank line, compiled by the backend. */
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
  default_temperature: number | null;
  /** Read-only creation time; null for agents created before it was recorded. */
  created_at: string | null;
}

/**
 * Write shape. The backend refuses the old single `instructions` text (it is read-only now);
 * instructions travel as `instruction_list`.
 */
export interface CreateAgentDefinitionRequest {
  name: string;
  instruction_list?: AgentInstruction[];
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
  default_temperature?: number | null;
}

/** `nextDefaultInstructionName`: first free `Instruction_N.md`, starting at N = list length + 1. */
export function nextDefaultInstructionName(list: readonly AgentInstruction[]): string {
  const taken = new Set(list.map((instruction) => instruction.name.trim().toLowerCase()));
  let number = list.length + 1;
  while (taken.has(`instruction_${number}.md`)) number++;
  return `Instruction_${number}.md`;
}

/**
 * One instruction document holding `instructions`, named as the editor names a first document;
 * blank text means no document. Flow source and the agent tools take a single instructions text.
 */
export function toInstructionList(instructions: string): AgentInstruction[] {
  return instructions.trim() === '' ? [] : [{ name: nextDefaultInstructionName([]), content: instructions }];
}

interface Paginated<T> {
  count: number;
  results: T[];
}

function unwrap<T>(response: Paginated<T> | T[]): T[] {
  return Array.isArray(response) ? response : response.results;
}

export class AgentDefinitionsApi {
  constructor(private readonly client: ApiClient) {}

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

  /** Delete an agent definition. Backend responds 204 (AgentDefinitionViewSet ModelViewSet). */
  async delete(id: number): Promise<void> {
    await this.client.delete<void>(`agent-definitions/${id}/`);
  }
}
