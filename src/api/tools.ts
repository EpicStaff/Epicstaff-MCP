import type { EpicStaffClient } from '../http/client.js';

/**
 * Tools API — ported from features/tools/services/
 * {tool-config,custom-tools/custom-tools-api,mcp-tools/mcp-tools}.service.ts.
 * Three kinds: configured built-in tools, python-code tools, MCP tools.
 */
export interface ToolConfig {
  id: number;
  name: string;
  tool: number;
  configuration: Record<string, unknown>;
}

export interface PythonCodeTool {
  id: number;
  name: string;
  description: string;
  variables?: unknown[];
  python_code?: { code: string; entrypoint: string; libraries: string[]; global_kwargs?: Record<string, unknown> };
}

export interface McpTool {
  id: number;
  name: string;
  transport: string;
  tool_name: string;
  timeout?: number;
  init_timeout?: number;
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
}

export interface CreateMcpToolRequest {
  name: string;
  transport: string;
  tool_name: string;
  timeout?: number;
  auth?: unknown;
  init_timeout?: number;
}

interface Paginated<T> {
  count: number;
  results: T[];
}

function unwrap<T>(response: Paginated<T> | T[]): T[] {
  return Array.isArray(response) ? response : response.results;
}

/** Built-in catalog tool (read-only route `tools/` — not user-creatable). */
export interface BuiltinTool {
  id: number;
  name: string;
  name_alias?: string;
}

export class ToolsApi {
  constructor(private readonly client: EpicStaffClient) {}

  async listBuiltinTools(): Promise<BuiltinTool[]> {
    return unwrap(await this.client.get<Paginated<BuiltinTool> | BuiltinTool[]>('tools/', { query: { limit: 1000 } }));
  }

  async listToolConfigs(): Promise<ToolConfig[]> {
    return unwrap(await this.client.get<Paginated<ToolConfig> | ToolConfig[]>('tool-configs/', { query: { limit: 1000 } }));
  }

  async listPythonCodeTools(): Promise<PythonCodeTool[]> {
    return unwrap(
      await this.client.get<Paginated<PythonCodeTool> | PythonCodeTool[]>('python-code-tool/', { query: { limit: 1000 } }),
    );
  }

  async listMcpTools(): Promise<McpTool[]> {
    return unwrap(await this.client.get<Paginated<McpTool> | McpTool[]>('mcp-tools/', { query: { limit: 1000 } }));
  }

  async createToolConfig(request: { name: string; configuration: Record<string, unknown>; tool: number }): Promise<ToolConfig> {
    return this.client.post('tool-configs/', { body: request });
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
