import type { ApiClient } from '../http/client.js';

/**
 * Tools API — ported from features/tools/services/
 * {custom-tools/custom-tools,mcp-tools/mcp-tools}.service.ts, plus the backend-only
 * `python-code-tool-configs/` route (tables/views: PythonCodeToolConfigViewSet), which
 * the frontend does not call.
 *
 * Three kinds: python-code tools (custom, or `built_in: true` catalog tools), configured
 * tools (a named configuration of a python-code tool), MCP tools.
 */
export interface ToolConfig {
  id: number;
  name: string;
  /** The configured python-code tool (built-in or custom). */
  tool: number;
  configuration: Record<string, unknown>;
}

export interface PythonCodeTool {
  id: number;
  name: string;
  description: string;
  variables?: unknown[];
  python_code?: { code: string; entrypoint: string; libraries: string[]; global_kwargs?: Record<string, unknown> };
  /** Catalog tool shipped with EpicStaff (visible to every org, not editable). */
  built_in?: boolean;
  is_favorite?: boolean;
  labels?: number[];
  use_storage?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface McpTool {
  id: number;
  name: string;
  transport: string;
  tool_name: string;
  timeout?: number;
  init_timeout?: number;
  /** Org Secret with the server auth credential. */
  auth_secret_id?: number | null;
  is_favorite?: boolean;
  labels?: number[];
}

export interface CreatePythonCodeToolRequest {
  name: string;
  description: string;
  variables: unknown[];
  python_code: {
    code: string;
    entrypoint: string;
    libraries: string[];
    global_kwargs?: Record<string, unknown>;
  };
  use_storage?: boolean;
  labels?: number[];
}

export interface CreateMcpToolRequest {
  name: string;
  transport: string;
  tool_name: string;
  timeout?: number;
  auth_secret_id?: number | null;
  init_timeout?: number;
  labels?: number[];
}

export interface CreateToolConfigRequest {
  name: string;
  tool: number;
  configuration: Record<string, unknown>;
}

interface Paginated<T> {
  count: number;
  results: T[];
}

function unwrap<T>(response: Paginated<T> | T[]): T[] {
  return Array.isArray(response) ? response : response.results;
}

export class ToolsApi {
  constructor(private readonly client: ApiClient) {}

  /** Built-in catalog tools: the `built_in` rows of `python-code-tool/`. */
  async listBuiltinTools(): Promise<PythonCodeTool[]> {
    return (await this.listPythonCodeTools()).filter((tool) => tool.built_in === true);
  }

  async listToolConfigs(): Promise<ToolConfig[]> {
    return unwrap(
      await this.client.get<Paginated<ToolConfig> | ToolConfig[]>('python-code-tool-configs/', {
        query: { limit: 1000 },
      }),
    );
  }

  /** Every python-code tool visible to the org: its custom tools plus the built-in catalog. */
  async listPythonCodeTools(): Promise<PythonCodeTool[]> {
    return unwrap(
      await this.client.get<Paginated<PythonCodeTool> | PythonCodeTool[]>('python-code-tool/', {
        query: { limit: 1000 },
      }),
    );
  }

  async listMcpTools(): Promise<McpTool[]> {
    return unwrap(await this.client.get<Paginated<McpTool> | McpTool[]>('mcp-tools/', { query: { limit: 1000 } }));
  }

  async createToolConfig(request: CreateToolConfigRequest): Promise<ToolConfig> {
    return this.client.post('python-code-tool-configs/', { body: request });
  }

  async updateToolConfig(id: number, request: Partial<CreateToolConfigRequest>): Promise<ToolConfig> {
    return this.client.patch(`python-code-tool-configs/${id}/`, { body: request });
  }

  async createPythonCodeTool(request: CreatePythonCodeToolRequest): Promise<PythonCodeTool> {
    return this.client.post('python-code-tool/', { body: request });
  }

  async updatePythonCodeTool(id: number, request: Partial<CreatePythonCodeToolRequest>): Promise<PythonCodeTool> {
    return this.client.patch(`python-code-tool/${id}/`, { body: request });
  }

  async createMcpTool(request: CreateMcpToolRequest): Promise<McpTool> {
    return this.client.post('mcp-tools/', { body: request });
  }

  async updateMcpTool(id: number, request: Partial<CreateMcpToolRequest>): Promise<McpTool> {
    return this.client.patch(`mcp-tools/${id}/`, { body: request });
  }
}
