import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
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
 * Registration must not touch the context's services (they throw when the
 * environment is invalid — see createUnconfiguredContext); handlers resolve them lazily.
 */
export function registerAllTools(server: McpServer, context: AppContext): void {
  registerAuthOrgTools(server, context);
  registerFlowTools(server, context);
  registerRunTools(server, context);
  registerReferenceTools(server, context);
  registerUiTools(server, context);
  registerKnowledgeTools(server, context);
  registerCatalogTools(server, context);
}
