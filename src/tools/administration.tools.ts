import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { registerAccountTools } from './account.tools.js';
import { registerAdminRbacTools } from './admin-rbac.tools.js';
import { registerAuditTools } from './audit.tools.js';
import { registerFirstSetupTools } from './first-setup.tools.js';
import { registerPluginTools } from './plugin.tools.js';

/**
 * Instance and workspace administration — the es-admin skill's tools: the user's own account and
 * API keys, first-run setup, users / memberships / roles / API keys / organizations, plugins and the
 * audit trail. Grouped behind one registration so the registry stays a single line for the area.
 */
export function registerAdministrationTools(server: McpServer, context: AppContext): void {
  registerAccountTools(server, context);
  registerFirstSetupTools(server, context);
  registerAdminRbacTools(server, context);
  registerPluginTools(server, context);
  registerAuditTools(server, context);
}
