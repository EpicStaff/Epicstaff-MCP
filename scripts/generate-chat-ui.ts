/**
 * Standalone chat-UI generator (the same rendering the `generate_chat_ui` MCP tool uses).
 *
 *   tsx scripts/generate-chat-ui.ts <spec.json> <out.html>
 *
 * Connection creds (apiUrl, orgId and that organization's apiKey — EpicStaff binds a key to one
 * organization) are read from the persisted es_mcp state in ~/.es_mcp (or $ES_MCP_STATE_DIR). The spec.json supplies the flow-specific fields
 * (graphId, graphName, title, inputPath, replyPath, resetVariables, welcome, ...).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { renderChatUi, type ChatUiConfig } from '../src/ui/chat-ui.js';

function loadCreds(): { apiUrl: string; apiKey: string; orgId: number } {
  const dir = process.env.ES_MCP_STATE_DIR ?? join(homedir(), '.es_mcp');
  const files = readdirSync(dir).filter((file) => file.endsWith('.json'));
  if (files.length === 0) throw new Error(`No es_mcp state file found in ${dir}. Connect first.`);
  const state = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8'));
  if (state.activeOrgId == null) throw new Error('Persisted state has no activeOrgId — select an organization.');
  const apiKey = state.apiKeys?.[state.activeOrgId]?.key;
  if (!apiKey) throw new Error('Persisted state has no API key for the active organization — connect first.');
  return { apiUrl: state.baseUrl, apiKey, orgId: state.activeOrgId };
}

const [, , specPath, outPath] = process.argv;
if (!specPath || !outPath) {
  console.error('usage: tsx scripts/generate-chat-ui.ts <spec.json> <out.html>');
  process.exit(1);
}

const spec = JSON.parse(readFileSync(specPath, 'utf8')) as Partial<ChatUiConfig>;
const creds = loadCreds();
const html = renderChatUi({ ...creds, ...spec } as ChatUiConfig);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html);
console.log(`Wrote ${html.length} bytes to ${outPath}`);
