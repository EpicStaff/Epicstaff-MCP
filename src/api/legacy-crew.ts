import type { EpicStaffClient } from '../http/client.js';

/**
 * LEGACY CrewAI trio (/agents/, /tasks/, /crews/) — the old model behind the
 * deprecated crew node ("Project" in the old UI). Kept only while CrewNode exists;
 * the primary path is AgentDefinition + Surface (see agent-definitions.ts / surfaces.ts).
 */
export interface LegacyCrew {
  id: number;
  name: string;
  process?: string;
  agents?: number[];
  tasks?: number[];
}

interface Paginated<T> {
  count: number;
  results: T[];
}

function unwrap<T>(response: Paginated<T> | T[]): T[] {
  return Array.isArray(response) ? response : response.results;
}

export class LegacyCrewApi {
  constructor(private readonly client: EpicStaffClient) {}

  async listCrews(): Promise<LegacyCrew[]> {
    return unwrap(await this.client.get<Paginated<LegacyCrew> | LegacyCrew[]>('crews/', { query: { limit: 1000 } }));
  }

  async createCrew(request: {
    name: string;
    description?: string | null;
    process: 'sequential' | 'hierarchical';
    memory?: boolean | null;
    agents?: number[];
    tasks?: number[];
  }): Promise<LegacyCrew> {
    return this.client.post('crews/', { body: request });
  }
}
