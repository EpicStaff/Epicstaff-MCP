import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import { createContext } from '../context.js';
import { registerAuthOrgTools } from './auth-org.tools.js';
import { registerFlowTools } from './flow.tools.js';
import { registerRunTools } from './run.tools.js';
import { registerReferenceTools } from './reference.tools.js';
import { registerUiTools } from './ui.tools.js';
import { registerKnowledgeTools } from './knowledge.tools.js';
import { registerCatalogTools } from './catalog.tools.js';

/**
 * Central tool registration. Each tool category module exports a
 * `register<Category>Tools(server, context)` function; this aggregates them.
 * Categories are added as they are built (auth/org → flow lifecycle → test loop → reference).
 */
export function registerAllTools(server: McpServer, config: Config): void {
  const context = createContext(config);
  registerAuthOrgTools(server, context);
  registerFlowTools(server, context);
  registerRunTools(server, context);
  registerReferenceTools(server, context);
  registerUiTools(server, context);
  registerKnowledgeTools(server, context);
  registerCatalogTools(server, context);
}
