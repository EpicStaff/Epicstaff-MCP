import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { logger } from './util/logger.js';
import { registerAllTools } from './tools/registry.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const server = new McpServer({
    name: 'epicstaff',
    version: '0.2.0',
  });

  registerAllTools(server, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`EpicStaff MCP server started (api: ${config.apiUrl}, user: ${config.email})`);
}

main().catch((error) => {
  logger.error('Fatal startup error', error);
  process.exit(1);
});
