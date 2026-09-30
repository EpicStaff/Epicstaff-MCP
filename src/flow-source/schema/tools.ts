/**
 * `tools` section — three named-map subsections:
 *  - `tool_configs`        configurations of built-in EpicStaff catalog tools
 *  - `python_code_tools`   custom Python tools (inline code or a local file)
 *  - `mcp_tools`           MCP server tools (stdio command or remote URL)
 */
import { z } from 'zod';

import { symbolicNameSchema } from './common.js';

export const toolConfigSchema = z
  .strictObject({
    tool: z
      .string()
      .min(1)
      .describe('Name of the built-in EpicStaff tool this config is for (backend tool catalog name).'),
    description: z.string().optional().describe('What this configured tool is used for.'),
    config: z
      .record(z.string(), z.unknown())
      .default({})
      .describe('Key/value configuration for the built-in tool, passed through as-is.'),
  })
  .describe('Configuration of a built-in catalog tool.');

export type ToolConfigSource = z.infer<typeof toolConfigSchema>;

export const pythonCodeToolSchema = z
  .strictObject({
    description: z
      .string()
      .min(1)
      .describe('What the tool does — shown to the LLM deciding whether to call it.'),
    args_schema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('JSON-schema-like description of the tool arguments.'),
    code: z
      .string()
      .optional()
      .describe('Inline Python source defining the entrypoint. Provide exactly one of code / code_file.'),
    code_file: z
      .string()
      .optional()
      .describe(
        'Path to a Python file relative to the flow directory. Provide exactly one of code / code_file.',
      ),
    entrypoint: z
      .string()
      .default('main')
      .describe('Name of the Python function called as the tool entrypoint.'),
    libraries: z
      .array(z.string())
      .default([])
      .describe('pip packages installed into the tool sandbox before execution.'),
  })
  .superRefine((tool, ctx) => {
    const hasCode = tool.code !== undefined;
    const hasCodeFile = tool.code_file !== undefined;
    if (hasCode === hasCodeFile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'provide exactly one of code / code_file',
      });
    }
  })
  .describe('A custom Python tool executed in the sandbox.');

export type PythonCodeToolSource = z.infer<typeof pythonCodeToolSchema>;

export const mcpToolSchema = z
  .strictObject({
    description: z.string().optional().describe('What this MCP tool/server provides.'),
    command: z
      .string()
      .optional()
      .describe('Command launching a stdio MCP server, e.g. "npx". Provide exactly one of command / url.'),
    args: z.array(z.string()).default([]).describe('Arguments for the stdio server command.'),
    env: z
      .record(z.string(), z.string())
      .default({})
      .describe('Environment variables for the stdio server process.'),
    url: z
      .string()
      .optional()
      .describe('URL of a remote MCP server (SSE/HTTP). Provide exactly one of command / url.'),
  })
  .superRefine((tool, ctx) => {
    const hasCommand = tool.command !== undefined;
    const hasUrl = tool.url !== undefined;
    if (hasCommand === hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'provide exactly one of command / url',
      });
    }
  })
  .describe('An MCP tool served by a stdio command or a remote MCP server.');

export type McpToolSource = z.infer<typeof mcpToolSchema>;

export const toolsSectionSchema = z
  .strictObject({
    tool_configs: z
      .record(symbolicNameSchema, toolConfigSchema)
      .default({})
      .describe('Built-in tool configurations, keyed by symbolic name.'),
    python_code_tools: z
      .record(symbolicNameSchema, pythonCodeToolSchema)
      .default({})
      .describe('Custom Python tools, keyed by symbolic name.'),
    mcp_tools: z
      .record(symbolicNameSchema, mcpToolSchema)
      .default({})
      .describe('MCP tools, keyed by symbolic name.'),
  })
  .default({})
  .describe('Tool definitions available to surfaces in this flow.');

export type ToolsSectionSource = z.infer<typeof toolsSectionSchema>;
