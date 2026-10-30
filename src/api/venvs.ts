import type { ApiClient } from '../http/client.js';

/**
 * Virtual environments (venvs) API — ported from
 * features/virtual-environments/services/venvs-api.service.ts + models/venv.model.ts.
 *
 * EpicStaff replaced per-code `libraries` with venvs: python nodes, python tools and code blocks
 * run in the venv their `python_code.venv_id` names (null = the sandbox's default one). The
 * backend gateway (proxies/sandbox/views.py, SandboxVenvBindingViewSet) is org-scoped and
 * addresses a venv by its binding id — the same id `venv_id` stores.
 */

/** Mirrors VENV_NAME_PATTERN in the sandbox service's Venv model (the frontend keeps the same copy). */
export const VENV_NAME_PATTERN = /^[A-Za-z0-9 _-]+$/;

/** Mirrors VERSION_PATTERN in the sandbox service's Library model (PEP 440 version). */
export const VENV_LIBRARY_VERSION_PATTERN =
  /^([1-9][0-9]*!)?(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))*((a|b|rc)(0|[1-9][0-9]*))?(\.post(0|[1-9][0-9]*))?(\.dev(0|[1-9][0-9]*))?(\+[a-z0-9]+([-_.][a-z0-9]+)*)?$/;

/**
 * Shape of a PEP 440 specifier set such as `!=1.2,>=1.0,<=1.8`. Deliberately loose — the sandbox
 * validates the set with `packaging.SpecifierSet` and is the authority.
 */
export const VENV_LIBRARY_SPECIFICATION_PATTERN =
  /^\s*(===|==|!=|~=|>=|<=|>|<)\s*[0-9A-Za-z][0-9A-Za-z.*+!_-]*(\s*,\s*(===|==|!=|~=|>=|<=|>|<)\s*[0-9A-Za-z][0-9A-Za-z.*+!_-]*)*\s*$/;

/** The sandbox venv lifecycle (the service's VenvStatus enum). */
export type VenvStatus = 'declared' | 'processing' | 'completed' | 'failed';

/** Statuses whose build is still ahead or under way; code that runs in the venv waits for it. */
export const BUILDING_STATUSES: ReadonlySet<VenvStatus> = new Set<VenvStatus>(['declared', 'processing']);

/**
 * One library of a venv. `version` is the installed version (a user pin, or what the last build
 * resolved); `specification` is the specifier set the version is validated against.
 */
export interface VenvLib {
  name: string;
  specification: string;
  version: string | null;
  description: string | null;
}

/** Creator of the binding row; null when unknown. */
export interface VenvOwner {
  id: number;
  email: string;
  display_name: string | null;
}

export interface Venv {
  id: number;
  name: string;
  libs: VenvLib[];
  status: VenvStatus;
  error: string | null;
  owner: VenvOwner | null;
  created_at: string | null;
  is_favorite: boolean;
}

export interface CreateVenvRequest {
  name: string;
  libs: VenvLib[];
}

export type UpdateVenvRequest = Partial<CreateVenvRequest>;

/** `order` mirrors the service's VenvOrder. */
export type VenvSortOrder = 'default' | 'name_asc' | 'name_desc';

export interface VenvListQuery {
  search?: string;
  order?: VenvSortOrder;
  isFavorite?: boolean;
}

/**
 * The venv list envelope uses `result` (singular), not `results`: it passes through the sandbox's
 * VenvListSchema.
 */
interface VenvListResponse {
  count: number;
  limit: number;
  offset: number;
  next: string | null;
  previous: string | null;
  result: Venv[];
}

const LIST_LIMIT = 1000;

export class VenvsApi {
  constructor(private readonly client: ApiClient) {}

  async list(query: VenvListQuery = {}): Promise<Venv[]> {
    const response = await this.client.get<VenvListResponse>('venvs/', {
      query: {
        limit: LIST_LIMIT,
        ...(query.search ? { search: query.search } : {}),
        ...(query.order ? { order: query.order } : {}),
        // Only the narrowing is a filter; 'false' would mean the same as no filter at all.
        ...(query.isFavorite ? { is_favorite: 'true' } : {}),
      },
    });
    return response.result;
  }

  /** Venv names are not unique upstream; match exactly first, then case-insensitively. */
  async findByName(name: string): Promise<Venv[]> {
    const venvs = await this.list({ search: name });
    const exact = venvs.filter((venv) => venv.name === name);
    if (exact.length > 0) return exact;
    const wanted = name.toLowerCase();
    return venvs.filter((venv) => venv.name.toLowerCase() === wanted);
  }

  async get(id: number): Promise<Venv> {
    return this.client.get<Venv>(`venvs/${id}/`);
  }

  async create(body: CreateVenvRequest): Promise<Venv> {
    return this.client.post<Venv>('venvs/', { body });
  }

  async update(id: number, body: UpdateVenvRequest): Promise<Venv> {
    return this.client.patch<Venv>(`venvs/${id}/`, { body });
  }

  /** Refused with 409 (venv_in_use) while any python code still runs in it — including binned owners. */
  async delete(id: number): Promise<void> {
    await this.client.delete<void>(`venvs/${id}/`);
  }
}
