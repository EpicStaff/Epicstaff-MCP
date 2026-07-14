import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { err, ok, toContent } from '../util/result.js';
import { ApiError } from '../http/errors.js';

/** Wrap a tool handler: run it, render the ToolResult envelope, normalize thrown errors. */
export async function runTool<T>(work: () => Promise<T>): Promise<ReturnType<typeof toContent>> {
  try {
    return toContent(ok(await work()));
  } catch (error) {
    if (error instanceof ApiError) {
      return toContent(
        err(error.message, {
          validationErrors: error.validationErrors,
          hint: hintFor(error),
          status: error.status,
          url: error.url,
          // Only useful when the failure wasn't already decoded into validationErrors.
          ...(error.validationErrors?.length ? {} : { bodyExcerpt: error.bodyExcerpt }),
        }),
      );
    }
    return toContent(err(error instanceof Error ? error.message : String(error)));
  }
}

function hintFor(error: ApiError): string | undefined {
  if (error.status === 401) {
    return 'Authentication failed even after re-minting — verify ES_EMAIL / ES_PASSWORD.';
  }
  if (error.status === 403) {
    return 'Check that the right organization is active (list_organizations / set_active_organization) and the user has permission.';
  }
  if (error.validationErrors?.length) {
    return 'Fix the listed fields in the flow source and retry.';
  }
  return undefined;
}

export function registerAuthOrgTools(server: McpServer, context: AppContext): void {
  server.registerTool(
    'check_connection',
    {
      title: 'Check EpicStaff connection',
      description:
        'Verify connectivity and authentication with the EpicStaff backend: validates or mints the API key ' +
        '(first launch logs in with credentials and mints a dedicated key), resolves organizations, and ' +
        'auto-selects the organization when there is exactly one. Call this first in every session.',
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        const orgStatus = await context.org.resolve();
        const { keyPrefix } = context.store.get();
        return {
          apiUrl: context.config.apiUrl,
          user: context.config.email,
          apiKeyPrefix: keyPrefix,
          organizations: orgStatus.organizations,
          activeOrgId: orgStatus.activeOrgId,
          ...(orgStatus.selectionRequired && {
            actionRequired:
              'Multiple organizations available — call set_active_organization with one of the listed ids before creating anything.',
          }),
        };
      }),
  );

  server.registerTool(
    'list_organizations',
    {
      title: 'List organizations',
      description:
        'List the organizations the configured user belongs to, and which one is currently active. ' +
        'A user can belong to more than one organization; every entity (flow, agent, surface) lives in exactly one.',
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        return context.org.resolve();
      }),
  );

  server.registerTool(
    'set_active_organization',
    {
      title: 'Set active organization',
      description:
        'Select the active organization. All subsequent API calls carry it as X-Organization-Id; ' +
        'flows and entities are created inside it. Required before any create/push when the user has several organizations.',
      inputSchema: {
        organization_id: z.number().int().describe('Organization id from list_organizations'),
      },
    },
    async ({ organization_id }) =>
      runTool(async () => {
        await context.auth.ensureAuthenticated();
        return context.org.setActive(organization_id);
      }),
  );
}
