import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FirstSetupApi } from '../api/first-setup.js';
import type { AppContext } from '../context.js';
import { confirmFlag } from './admin-helpers.js';
import { runTool } from './auth-org.tools.js';

/**
 * First-run setup of a brand-new EpicStaff instance: create its first superadmin (and the default
 * organization) through the anonymous first-setup endpoint. The account is the one the MCP server is
 * configured with — EPICSTAFF_USERNAME / EPICSTAFF_PASSWORD — so no credential is ever a tool argument
 * or appears in a result, and the MCP can sign in with it right after.
 *
 * Safe to expose because the backend closes the endpoint for good once any account exists (atomic,
 * under a bootstrap lock) and keeps it closed unless FIRST_SETUP_MODE=open. The tool checks the status
 * first and never posts to an instance that does not ask for setup.
 */

const CLI_SETUP_HINT =
  'If this instance has no account yet, its first-setup page is closed (FIRST_SETUP_MODE is not "open" — the ' +
  'safe default for a reachable server): create the superadmin on the server with the create_superadmin ' +
  'management command instead.';

export function registerFirstSetupTools(server: McpServer, context: AppContext): void {
  const setup = new FirstSetupApi(context.client);

  server.registerTool(
    'get_setup_status',
    {
      title: 'Check whether EpicStaff needs first-run setup',
      description:
        'Ask the EpicStaff instance whether it still needs its first superadmin (a fresh install with no accounts). ' +
        'Use it when check_connection fails to log in on a new instance. Needs no login.',
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        const status = await setup.getStatus();
        return {
          ...status,
          next: status.needs_setup
            ? 'complete_first_setup creates the first superadmin with the EPICSTAFF_USERNAME / EPICSTAFF_PASSWORD ' +
              'this MCP server is configured with — only on an explicit request of the instance owner.'
            : `Nothing to set up over the API. ${CLI_SETUP_HINT} Otherwise log in with an existing account (check_connection).`,
        };
      }),
  );

  server.registerTool(
    'complete_first_setup',
    {
      title: 'Create the first superadmin of a fresh instance',
      description:
        'On a brand-new EpicStaff instance that asks for setup (get_setup_status: needs_setup), create its FIRST ' +
        'SUPERADMIN — full control of the instance — from the EPICSTAFF_USERNAME / EPICSTAFF_PASSWORD this MCP ' +
        'server is configured with, plus the default organization. Refused when the instance already has an account ' +
        'or its setup page is closed. Run it only when the owner of the instance asks for it. Requires confirm: true.',
      inputSchema: {
        display_name: z.string().max(255).optional().describe('Display name of the superadmin; omitted → from the email.'),
        confirm: confirmFlag('set up this EpicStaff instance with the configured account as its superadmin'),
      },
    },
    async ({ display_name }) =>
      runTool(async () => {
        const { email, password } = context.config;
        if (email === undefined || password === undefined) {
          throw new Error(
            'First setup creates the superadmin from EPICSTAFF_USERNAME + EPICSTAFF_PASSWORD, and this MCP server is ' +
              'configured with an API token only. Set the two variables to the account you want, restart, and retry.',
          );
        }
        const status = await setup.getStatus();
        if (!status.needs_setup) {
          throw new Error(`This instance does not ask for first setup (setup_mode: ${status.setup_mode}); nothing was sent. ${CLI_SETUP_HINT}`);
        }
        const result = await setup.complete({ email, password, ...(display_name !== undefined ? { display_name } : {}) });
        return {
          superadmin: result.user,
          organization: result.organization,
          next: 'Call check_connection: the MCP now logs in with that account and selects the organization.',
        };
      }),
  );
}
