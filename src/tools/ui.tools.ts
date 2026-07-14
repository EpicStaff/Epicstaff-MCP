import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { GraphsApi } from '../api/graphs.js';
import { renderChatUi } from '../ui/chat-ui.js';
import { runTool } from './auth-org.tools.js';

/**
 * UI generation — the "front-end" half of a chat flow. Emits a self-contained HTML chat client
 * wired to a pushed graph's run-session API, so a flow you built with write → build → push → test
 * comes with a usable UI, not just an API.
 */
export function registerUiTools(server: McpServer, context: AppContext): void {
  const graphs = new GraphsApi(context.client);

  server.registerTool(
    'generate_chat_ui',
    {
      title: 'Generate a chat UI',
      description:
        'Generate a self-contained HTML chat UI (inline CSS/JS, no external assets) for a pushed flow ' +
        'graph. The page drives the graph via its run-session API, authenticating with the current ' +
        'API key + active organization (both CORS-allowed), so it works from file:// or any static ' +
        'host with no backend change. Configure how the user message maps into the flow via ' +
        'input_path, and where the reply is read from via reply_path. Set reset_variables to the ' +
        'downstream fields to clear each turn so persistent-variables graphs do not carry stale ' +
        'answers. Open the returned file path in a browser.',
      inputSchema: {
        graph_id: z.number().int().describe('Backend graph id to drive (from push_flow / list_graphs).'),
        output_path: z.string().describe('Absolute path of the .html file to write.'),
        title: z.string().optional().describe('Header title (defaults to the graph name).'),
        subtitle: z.string().optional().describe('Header subtitle / one-line description.'),
        input_path: z
          .string()
          .optional()
          .describe('Dotted variable path that receives the user message. Default "chat.message".'),
        reply_path: z
          .string()
          .optional()
          .describe('Dotted variable path holding the reply in the final state. Default "reply".'),
        reset_variables: z
          .record(z.unknown())
          .optional()
          .describe('Variables sent fresh each turn before the message is written, e.g. {"extraction":{},"quote":{},"reply":null}.'),
        welcome: z.string().optional().describe('Greeting bubble shown before the first user message.'),
        embed_api_key: z
          .boolean()
          .optional()
          .describe('Prefill the current API key into the page (default true). Set false to make the user enter it.'),
      },
    },
    async ({ graph_id, output_path, title, subtitle, input_path, reply_path, reset_variables, welcome, embed_api_key }) =>
      runTool(async () => {
        if (!isAbsolute(output_path)) {
          throw new Error('output_path must be an absolute path to a .html file.');
        }
        const apiKey = await context.auth.ensureAuthenticated();
        const orgId = context.org.requireActiveOrg();

        const light = await graphs.listLight();
        const graph = light.find((candidate) => candidate.id === graph_id);
        if (!graph) {
          throw new Error(`Graph ${graph_id} was not found in the active organization. Push it first.`);
        }

        const html = renderChatUi({
          apiUrl: context.config.apiUrl,
          graphId: graph_id,
          graphName: graph.name,
          orgId,
          apiKey: embed_api_key === false ? '' : apiKey,
          title,
          subtitle: subtitle ?? (graph.description || undefined),
          inputPath: input_path,
          replyPath: reply_path,
          resetVariables: reset_variables,
          welcome,
        });

        mkdirSync(dirname(output_path), { recursive: true });
        writeFileSync(output_path, html);

        return {
          output_path,
          open: `file://${output_path}`,
          graph_id,
          graph_name: graph.name,
          bytes: html.length,
          embedded_api_key: embed_api_key !== false,
          next: 'Open the file in a browser. Use the gear icon to change API base / key / org / graph id.',
        };
      }),
  );
}
