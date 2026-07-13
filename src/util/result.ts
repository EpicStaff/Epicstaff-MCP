/**
 * Uniform envelope every MCP tool returns, serialized as JSON in the tool result.
 * `hint` tells the calling LLM what to do next when something went wrong.
 */
export interface ValidationIssue {
  field: string;
  value: unknown;
  reason: string;
}

export interface ToolOk<T> {
  ok: true;
  data: T;
}

export interface ToolErr {
  ok: false;
  error: string;
  validationErrors?: ValidationIssue[];
  hint?: string;
}

export type ToolResult<T> = ToolOk<T> | ToolErr;

export function ok<T>(data: T): ToolOk<T> {
  return { ok: true, data };
}

export function err(error: string, options: Omit<ToolErr, 'ok' | 'error'> = {}): ToolErr {
  return { ok: false, error, ...options };
}

/** Render a ToolResult as MCP tool-call content. */
export function toContent(result: ToolResult<unknown>): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    ...(result.ok ? {} : { isError: true }),
  };
}
