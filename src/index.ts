import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { logger } from './util/logger.js';
import { registerAllTools } from './tools/registry.js';

/**
 * Server-level instructions. MCP clients deliver this to the model at connection — before any tool
 * call or skill — so Claude approaches every EpicStaff flow with the correct mental model of the
 * Domain (the flow state). The full teaching lives in the es-write-flow skill; this is the primer.
 */
const EPICSTAFF_INSTRUCTIONS = [
  'EpicStaff flows exchange ALL data through one state object — the Domain:',
  '{ variables: {…}, persistent_variables: { user: [], organization: [] } }.',
  '',
  'Nodes read and write variables.* via input_map (reads) and output_variable_path (writes).',
  'Edges carry CONTROL FLOW only — run order and branching — never data: a node sees a value',
  'because it reads a path some earlier node wrote, NOT because an edge connects them. Connecting',
  'A → B does not hand A’s output to B; wiring input_map / output_variable_path does.',
  '',
  "The start node's `variables` is the authoritative Domain (minimal valid form { variables: {} } —",
  'no inner key is mandatory). persistent_variables lists variable NAMES carried across sessions,',
  'scoped to exactly "user" or "organization".',
  '',
  'Invariants: agent nodes need at least one task (tasks:); no parallel fan-out — one active path,',
  'branch with a decision-table or conditional edge; never use node types "llm" or "code-agent"',
  '("crew" is deprecated, prefer agent/task nodes). Call describe_node_types for the full node',
  'catalog (fields + runtime caveats).',
  '',
  'Build flows with the es-* skills (front door: es-deliver → es-write-flow → build → push → test).',
].join('\n');

async function main(): Promise<void> {
  const config = loadConfig();
  const server = new McpServer(
    {
      name: 'epicstaff',
      version: '0.2.0',
    },
    { instructions: EPICSTAFF_INSTRUCTIONS },
  );

  registerAllTools(server, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`EpicStaff MCP server started (api: ${config.apiUrl}, user: ${config.email})`);
}

main().catch((error) => {
  logger.error('Fatal startup error', error);
  process.exit(1);
});
