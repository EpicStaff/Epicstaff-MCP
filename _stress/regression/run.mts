/**
 * Live regression suite — drives the BUILT plugin (dist/index.js) over MCP stdio, exactly like
 * Claude Code does, against a running EpicStaff, and exercises every registered tool.
 *
 *   npm run build && npx tsx _stress/regression/run.mts
 *
 * Environment (nothing else is read; no ids, model ids or paths are hardcoded):
 *   EPICSTAFF_BASE_URL, EPICSTAFF_USERNAME, EPICSTAFF_PASSWORD   instance + test user (required)
 *   STRESS_OPENAI_KEY        provider key for the LLM steps (required; stored as an org secret)
 *   REG_LLM_MODEL            model name   (default gpt-4o-mini)
 *   REG_LLM_PROVIDER         provider     (default openai)
 *   ES_MCP_STATE_DIR         MCP key/session state (default _stress/regression/out/state) — keep it
 *                            stable across runs so the minted API key is reused (5 active keys per user)
 *   REG_KEEP=1               keep the graphs / agents / llm configs the run created (default: delete)
 *
 * Output: a PASS / FAIL / SKIP table; exit code 1 on any FAIL or on a tool that was never exercised.
 * Scratch flows, dumps and results go to _stress/regression/out/ (gitignored).
 * RAG indexing needs an embedding model, so attach_rag / provision_knowledge are SKIPped.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../../src/config.js';
import { createContext } from '../../src/context.js';
import { readLock } from '../../src/flow-source/lockfile.js';

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', 'dist', 'index.js');
const TEMPLATES = join(HERE, 'flows');
const OUT = join(HERE, 'out');
const RUN = Date.now().toString(36);
const RUN_DIR = join(OUT, `run-${RUN}`);
const FLOWS = join(RUN_DIR, 'flows');

for (const name of ['EPICSTAFF_BASE_URL', 'EPICSTAFF_USERNAME', 'EPICSTAFF_PASSWORD', 'STRESS_OPENAI_KEY']) {
  if (!process.env[name]) {
    console.error(`${name} is not set — see the header of this file.`);
    process.exit(2);
  }
}
if (!existsSync(DIST)) {
  console.error(`${DIST} not found — run \`npm run build\` first (the suite tests the built plugin).`);
  process.exit(2);
}
process.env.ES_MCP_STATE_DIR ??= join(OUT, 'state');
const MODEL = process.env.REG_LLM_MODEL ?? 'gpt-4o-mini';
const PROVIDER = process.env.REG_LLM_PROVIDER ?? 'openai';
// A fixed, obviously fake bot token: secrets are immutable, so a per-run value would conflict.
const FAKE_TELEGRAM_TOKEN = '111111111:regression-fake-telegram-token';
const TELEGRAM_TOKEN_ENV = 'REGRESSION_FAKE_TG_TOKEN';

mkdirSync(FLOWS, { recursive: true });
for (const template of readdirSync(TEMPLATES)) {
  // Directory name = flow name (sibling subgraph refs resolve by it), made unique per run.
  const name = template.replaceAll('__RUN__', RUN);
  cpSync(join(TEMPLATES, template), join(FLOWS, name), { recursive: true });
  const file = join(FLOWS, name, 'flow.yaml');
  writeFileSync(
    file,
    readFileSync(file, 'utf8')
      .replaceAll('__RUN__', RUN)
      .replaceAll('__MODEL__', MODEL)
      .replaceAll('__PROVIDER__', PROVIDER)
      .replaceAll('__KEY_ENV__', 'STRESS_OPENAI_KEY'),
  );
}
/** Scratch dir of a template: `flow('reg-core')` → out/run-<id>/flows/reg-core-<id>. */
const flow = (name: string): string => (existsSync(join(TEMPLATES, name)) ? join(FLOWS, name) : join(FLOWS, `${name}-${RUN}`));

// ---------------------------------------------------------------------------------------------
// MCP client + result table
// ---------------------------------------------------------------------------------------------

type Verdict = 'PASS' | 'FAIL' | 'SKIP';
interface Row {
  label: string;
  tool: string;
  verdict: Verdict;
  ms: number;
  note: string;
}
interface ToolResponse {
  ok: boolean;
  data?: any;
  error?: string;
  hint?: string;
  isError: boolean;
  text: string;
  ms: number;
}

const rows: Row[] = [];
const seenKeyPrefixes = new Set<string>();
const exercised = new Set<string>();
const SECRETISH = /\b(es|sk)-[A-Za-z0-9_-]{12,}/g;
const redact = (text: string): string => text.replace(SECRETISH, '$1-<redacted>');

class Server {
  private constructor(
    readonly client: Client,
    private readonly transport: StdioClientTransport,
    private readonly stderrChunks: string[],
  ) {}

  static async start(env: Record<string, string | undefined> = process.env): Promise<Server> {
    const cleanEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST],
      env: cleanEnv,
      stderr: 'pipe',
    });
    const chunks: string[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    const client = new Client({ name: 'epicstaff-regression', version: '1' });
    await client.connect(transport);
    return new Server(client, transport, chunks);
  }

  /** Server log (stderr) — read for auth-path assertions, never printed. */
  get log(): string {
    return this.stderrChunks.join('');
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResponse> {
    exercised.add(name);
    const started = Date.now();
    try {
      const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
      const text = (result.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? '';
      let body: { ok?: boolean; data?: unknown; error?: string; hint?: string };
      try {
        body = JSON.parse(text);
      } catch {
        body = { ok: !result.isError, error: result.isError ? text : undefined };
      }
      return { ok: body.ok === true, data: body.data, error: body.error, hint: body.hint, isError: result.isError === true, text, ms: Date.now() - started };
    } catch (error) {
      return { ok: false, error: String((error as Error).message ?? error), isError: true, text: '', ms: Date.now() - started };
    }
  }

  async close(): Promise<void> {
    await this.client.close();
    await this.transport.close().catch(() => undefined);
    // Remember every API key prefix the plugin stored during this run (to revoke our own mints).
    const { keyPrefix } = restContext().store.get();
    if (keyPrefix) seenKeyPrefixes.add(keyPrefix);
  }
}

function record(label: string, tool: string, verdict: Verdict, ms: number, note = ''): void {
  rows.push({ label, tool, verdict, ms, note: redact(note) });
  console.log(`${verdict.padEnd(4)} ${String(ms).padStart(7)}ms  ${tool.padEnd(24)} ${label}${note ? `  -> ${redact(note).slice(0, 300)}` : ''}`);
}

/** Call a tool and judge it: `check` returns true, or a failure note. Default: the call succeeded. */
async function step(
  server: Server,
  label: string,
  tool: string,
  args: Record<string, unknown> = {},
  check: (response: ToolResponse) => true | string = (response) => response.ok || failure(response),
): Promise<ToolResponse> {
  const response = await server.call(tool, args);
  let verdict: Verdict = 'PASS';
  let note = '';
  try {
    const outcome = check(response);
    if (outcome !== true) {
      verdict = 'FAIL';
      note = outcome;
    }
  } catch (error) {
    verdict = 'FAIL';
    note = `check threw: ${(error as Error).message} | ${response.text.slice(0, 200)}`;
  }
  record(label, tool, verdict, response.ms, note);
  return response;
}

function assertion(label: string, tool: string, passed: boolean, note: string): void {
  record(label, tool, passed ? 'PASS' : 'FAIL', 0, passed ? '' : note);
}

function skip(label: string, tool: string, why: string): void {
  exercised.add(tool);
  record(label, tool, 'SKIP', 0, why);
}

const failure = (response: ToolResponse): string => response.error ?? response.text.slice(0, 300);
const json = (value: unknown): string => JSON.stringify(value) ?? 'undefined';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const TERMINAL = new Set(['end', 'error', 'stop', 'expired']);

async function waitForSession(server: Server, sessionId: number, timeoutMs = 240_000): Promise<ToolResponse> {
  const deadline = Date.now() + timeoutMs;
  let last = await server.call('get_session', { session_id: sessionId });
  while (!TERMINAL.has(last.data?.status) && Date.now() < deadline) {
    await sleep(3000);
    last = await server.call('get_session', { session_id: sessionId });
  }
  return last;
}

async function finalVariables(server: Server, sessionId: number): Promise<Record<string, any>> {
  const messages = await server.call('get_session_messages', { session_id: sessionId, limit: 200 });
  const final = messages.data?.final_variables ?? {};
  return (final.variables ?? final) as Record<string, any>;
}

/** Helper REST context (same state dir) for setup / cleanup the tools cannot do. Use only while no server runs. */
function restContext() {
  return createContext(loadConfig());
}

/** Call a JWT-only route with the stored user session; renew once if the server rejects the token. */
async function withUserSession<T>(call: (context: ReturnType<typeof restContext>, bearerToken: string) => Promise<T>): Promise<T> {
  const context = restContext();
  try {
    return await call(context, await context.auth.accessToken());
  } catch (error) {
    if ((error as { status?: number }).status !== 401) throw error;
    return call(context, await context.auth.renewAccessToken());
  }
}

async function listApiKeys(): Promise<Array<{ id: number; prefix: string; revoked: boolean }>> {
  const response = await withUserSession((context, bearerToken) => context.client.get<any>('profile/api-keys/', { bearerToken }));
  const keys = (Array.isArray(response) ? response : response.results) as Array<Record<string, unknown>>;
  return keys.map((key) => ({
    id: key.id as number,
    prefix: String(key.prefix ?? ''),
    revoked: key.status !== 'active', // ApiKeySerializer.status: active / revoked / expired
  }));
}

const created = { graphs: new Set<number>() };
const concurrentEntities: Array<[string, { backendId: number }]> = [];
const trackGraph = (response: ToolResponse): void => {
  const id = response.data?.graphId;
  if (typeof id === 'number') created.graphs.add(id);
};

// The key the state dir held BEFORE any server of this run started (reused, never revoked). Every
// key stored after this point — phase A included — was minted by this run and is revoked on cleanup.
const initialKey = (() => {
  const { apiKey, keyPrefix } = restContext().store.get();
  return apiKey && keyPrefix ? { apiKey, keyPrefix } : null;
})();

// ---------------------------------------------------------------------------------------------
// A. Startup without configuration (issues 6, 7)
// ---------------------------------------------------------------------------------------------

{
  const { EPICSTAFF_BASE_URL: _url, ...withoutUrl } = process.env;
  const server = await Server.start({ ...withoutUrl, EPICSTAFF_BASE_URL: '${EPICSTAFF_BASE_URL}' });
  const { tools } = await server.client.listTools();
  assertion('unconfigured server starts and lists every tool', 'check_connection', tools.length === 89, `tools=${tools.length}`);
  await step(server, 'unconfigured: check_connection explains the config problem', 'check_connection', {}, (response) =>
    (!response.ok && /EPICSTAFF_BASE_URL/.test(response.error ?? '') && /EPICSTAFF_BASE_URL/.test(response.hint ?? '')) || response.text.slice(0, 300),
  );
  await step(server, 'unconfigured: local validate_flow still works', 'validate_flow', { flow_dir: flow('reg-child') });
  await server.close();
}
{
  const server = await Server.start({ ...process.env, EPICSTAFF_API_TOKEN: '${EPICSTAFF_API_TOKEN}' });
  await step(server, 'unexpanded ${EPICSTAFF_API_TOKEN} is treated as unset', 'check_connection', {}, (response) =>
    (response.ok && response.data.authMode === 'api-key') || `authMode=${response.data?.authMode} ${failure(response)}`,
  );
  await server.close();
}

// ---------------------------------------------------------------------------------------------
// B. Main session
// ---------------------------------------------------------------------------------------------

const server = await Server.start({ ...process.env, [TELEGRAM_TOKEN_ENV]: FAKE_TELEGRAM_TOKEN });

// Auth / org
const connection = await step(server, 'connect', 'check_connection', {}, (response) =>
  (response.ok && response.data.authMode === 'api-key' && response.data.activeOrgId != null) || failure(response),
);
const orgId: number | undefined = connection.data?.activeOrgId ?? connection.data?.organizations?.[0]?.id;
await step(server, 'list organizations', 'list_organizations', {}, (response) =>
  (response.ok && response.data.organizations.some((org: { id: number }) => org.id === orgId)) || failure(response),
);
await step(server, 'set active organization', 'set_active_organization', { organization_id: orgId ?? -1 });

// Reference
const nodeTypes = await step(server, 'all node types', 'describe_node_types', {}, (response) =>
  (response.ok && Array.isArray(response.data.node_types) && response.data.node_types.length > 0) || failure(response),
);
await step(server, 'one node type (key-value)', 'describe_node_types', { type: 'key-value' }, (response) =>
  (response.ok && json(response.data).includes('key-value')) || failure(response),
);
await step(server, `models search ${MODEL}`, 'list_llm_models', { search: MODEL }, (response) =>
  (response.ok && json(response.data).includes(MODEL)) || failure(response),
);
await step(server, 'llm configs', 'list_llm_configs');
await step(server, 'tools catalog', 'list_tools');
await step(server, 'agents', 'list_agents');
await step(server, 'surfaces', 'list_surfaces');
await step(server, 'graphs', 'list_graphs', {}, (response) => (response.ok && Array.isArray(response.data)) || failure(response));
await step(server, 'source collections', 'list_source_collections');
void nodeTypes;

// Local validation (issues 4, 8, 12)
await step(server, 'crew node rejected', 'validate_flow', { flow_dir: flow('crew') }, (response) =>
  (!response.ok && response.text.includes('EST-3849')) || 'no EST-3849 diagnostic',
);
await step(server, 'unknown key rejected', 'validate_flow', { flow_dir: flow('badkey') }, (response) =>
  (!response.ok && /instrutions/.test(response.text)) || 'typo not reported',
);
await step(server, '#12 EPICSTAFF_*/ES_MCP_* credential env names rejected', 'validate_flow', { flow_dir: flow('secret-leak') }, (response) =>
  (!response.ok && /api_key_env/.test(response.text) && /bot_token_env/.test(response.text)) || response.text.slice(0, 300),
);
await step(server, '#4 max_tokens < 500 rejected at build time', 'build_flow', { flow_dir: flow('small-max-tokens') }, (response) =>
  (!response.ok && /error/.test(response.error ?? '')) || response.text.slice(0, 300),
);
await step(server, '#4 ...with the field named by validate_flow', 'validate_flow', { flow_dir: flow('small-max-tokens') }, (response) =>
  (!response.ok && /max_tokens/.test(response.text) && /500/.test(response.text)) || response.text.slice(0, 300),
);
await step(server, '#8 init_flow scaffold', 'init_flow', { flow_dir: flow('init') }, (response) =>
  (response.ok && existsSync(join(flow('init'), 'flow.yaml'))) || failure(response),
);
await step(server, '#8 scaffold passes validate_flow', 'validate_flow', { flow_dir: flow('init') });
await step(server, '#8 scaffold passes build_flow', 'build_flow', { flow_dir: flow('init') });

// Core flow
await step(server, 'core validate', 'validate_flow', { flow_dir: flow('reg-core') });
await step(server, 'core build', 'build_flow', { flow_dir: flow('reg-core') });
await step(server, 'core diff before push', 'diff_flow', { flow_dir: flow('reg-core') }, (response) =>
  (response.ok && /create graph/.test(json(response.data.graph))) || failure(response),
);
const corePush = await step(server, 'core push', 'push_flow', { flow_dir: flow('reg-core') }, (response) =>
  (response.ok && typeof response.data.graphId === 'number' && response.data.createdGraph === true) || failure(response),
);
trackGraph(corePush);
const coreId: number = corePush.data?.graphId ?? -1;
const coreSaveVersion: number = corePush.data?.saveVersion;
await step(server, '#3 no-op repush skips the bulk save', 'push_flow', { flow_dir: flow('reg-core') }, (response) =>
  (response.ok && response.data.changed === false && response.data.saveVersion === coreSaveVersion &&
    response.data.graphId === coreId && /no changes/.test(response.data.status ?? '')) ||
  `changed=${response.data?.changed} saveVersion ${response.data?.saveVersion} vs ${coreSaveVersion} nodes=${json(response.data?.nodes)} ` +
    `entities=${json((response.data?.entities ?? []).filter((entity: { action: string }) => entity.action !== 'reused' && entity.action !== 'resolved-existing'))} ${response.ok ? '' : failure(response)}`,
);
await step(server, '#3 ...and no entity churn', 'diff_flow', { flow_dir: flow('reg-core') }, (response) =>
  (response.ok && response.data.graph.conflict === null && response.data.graph.remoteSaveVersion === coreSaveVersion &&
    response.data.entities.every((entity: { wouldDo: string }) => entity.wouldDo !== 'update' && entity.wouldDo !== 'create')) ||
  json(response.data).slice(0, 300),
);

const lastVariables = new Map<string, Record<string, any>>();

async function runAndVerify(label: string, graphId: number, initialState: Record<string, unknown>, verify: (variables: Record<string, any>) => true | string) {
  const started = await step(server, `${label}: run`, 'run_flow', { graph_id: graphId, initial_state: initialState }, (response) =>
    (response.ok && typeof response.data.session_id === 'number') || failure(response),
  );
  const sessionId: number = started.data?.session_id ?? -1;
  const done = await waitForSession(server, sessionId);
  const variables = done.data?.status === 'end' ? await finalVariables(server, sessionId) : {};
  lastVariables.set(label, variables);
  const outcome = done.data?.status === 'end' ? verify(variables) : `status=${done.data?.status} ${json(done.data?.status_data).slice(0, 200)}`;
  assertion(`${label}: result`, 'get_session', outcome === true, outcome === true ? '' : outcome);
  return sessionId;
}

const goldSession = await runAndVerify('core gold path (amount=150)', coreId, { amount: 150, customer: 'c_gold' }, (variables) =>
  (variables.tier?.tier === 'gold' && variables.loaded?.tier === 'gold' && typeof variables.verdict === 'string' && /gold/i.test(variables.verdict) &&
    variables.path === 'gold-path') ||
  json(variables).slice(0, 300),
);
await step(server, 'session updates', 'get_session_updates', { session_id: goldSession }, (response) =>
  (response.ok && response.data.isTerminal === true) || failure(response),
);
await step(server, 'session messages (concise)', 'get_session_messages', { session_id: goldSession, limit: 50 });
await step(server, 'list sessions for graph', 'list_sessions', { graph_id: coreId }, (response) =>
  (response.ok && json(response.data).includes(`"id":${goldSession}`)) || failure(response),
);
await runAndVerify('core basic path (amount=10)', coreId, { amount: 10, customer: 'c_basic' }, (variables) =>
  (variables.tier?.tier === 'basic' && variables.loaded?.tier === 'basic' && typeof variables.verdict === 'string' &&
    variables.path === 'basic-path') ||
  json(variables).slice(0, 300),
);

// Edit + repush updates in place (exercises the inherited python-code / task identities)
{
  const file = join(flow('reg-core'), 'flow.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('return {"tier": "gold", "amount": s["amount"]}', 'return {"tier": "gold", "amount": s["amount"], "edited": True}'));
  await step(server, 'edited repush updates one node in place', 'push_flow', { flow_dir: flow('reg-core') }, (response) =>
    (response.ok && response.data.graphId === coreId && response.data.changed === true &&
      response.data.nodes.created === 0 && response.data.nodes.updated === 1 && response.data.nodes.deleted === 0) ||
    json(response.data?.nodes ?? response.error),
  );
  await runAndVerify('edited core runs the new code (amount=500)', coreId, { amount: 500, customer: 'c_edit' }, (variables) =>
    (variables.tier?.edited === true && variables.loaded?.edited === true) || json(variables).slice(0, 300),
  );
}

// Subgraph
trackGraph(await step(server, 'child push', 'push_flow', { flow_dir: flow('reg-child') }));
const parentPush = await step(server, 'parent push (subgraph ref by sibling name)', 'push_flow', { flow_dir: flow('reg-parent') });
trackGraph(parentPush);
await runAndVerify('subgraph doubles 21', parentPush.data?.graphId ?? -1, { n: 21 }, (variables) =>
  json(variables.child ?? variables).includes('42') || json(variables).slice(0, 300),
);

// Two concurrent pushes of one new flow (round 4): serialized — one graph, one copy of each node.
{
  const dir = join(FLOWS, `reg-concurrent-${RUN}`);
  cpSync(flow('reg-core'), dir, { recursive: true });
  rmSync(join(dir, 'flow.lock.json'), { force: true });
  const file = join(dir, 'flow.yaml');
  writeFileSync(
    file,
    readFileSync(file, 'utf8')
      .replace(`name: reg-core-${RUN}`, `name: reg-concurrent-${RUN}`)
      .replaceAll(`reg-llm-${RUN}`, `reg-llm-c-${RUN}`)
      .replaceAll(`reg_writer_${RUN}`, `reg_writer_c_${RUN}`),
  );
  const [first, second] = await Promise.all([
    server.call('push_flow', { flow_dir: dir }),
    server.call('push_flow', { flow_dir: dir }),
  ]);
  exercised.add('push_flow');
  assertion('concurrent pushes both succeed on one graph', 'push_flow',
    first.ok && second.ok && first.data.graphId === second.data.graphId,
    `${first.error ?? first.data?.graphId} / ${second.error ?? second.data?.graphId}`);
  if (typeof first.data?.graphId === 'number') created.graphs.add(first.data.graphId);
  const sameName = ((await server.call('list_graphs')).data ?? []).filter((graph: { name: string }) => graph.name === `reg-concurrent-${RUN}`);
  assertion('...exactly one graph with that name', 'list_graphs', sameName.length === 1, `graphs=${sameName.length}`);
  const dumpPath = join(RUN_DIR, 'concurrent-dump.json');
  await step(server, '...and exactly one copy of each node', 'dump_graph', { graph_id: first.data?.graphId ?? -1, output_path: dumpPath }, (response) => {
    if (!response.ok) return failure(response);
    const dumped = JSON.parse(readFileSync(dumpPath, 'utf8'));
    const names = Object.entries(dumped)
      .filter(([key, value]) => key.endsWith('_list') && key !== 'edge_list' && Array.isArray(value))
      .flatMap(([, value]) => (value as Array<{ node_name?: string }>).map((node) => node.node_name ?? ''))
      .filter((name) => name !== '');
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    return (duplicates.length === 0 && names.length >= 10) || `names=${json(names)}`;
  });
  // Clean up the entities only this flow created.
  const concurrentLock = await readLock(dir);
  concurrentEntities.push(...Object.entries(concurrentLock?.entities ?? {}));
}

// Push-only node families
const triggersPush = await step(server, 'triggers push', 'push_flow', { flow_dir: flow('reg-triggers') });
trackGraph(triggersPush);
await step(server, 'telegram token stored as a secret, never in the graph', 'describe_graph', { graph_id: triggersPush.data?.graphId ?? -1 }, (response) =>
  (response.ok && !response.text.includes(FAKE_TELEGRAM_TOKEN)) || 'raw token visible in the graph',
);
trackGraph(await step(server, 'classification decision table push', 'push_flow', { flow_dir: flow('reg-classify') }));
trackGraph(await step(server, 'file-extractor + audio-to-text push', 'push_flow', { flow_dir: flow('reg-io') }));

// stop_session
{
  const slowPush = await step(server, 'slow push', 'push_flow', { flow_dir: flow('reg-slow') });
  trackGraph(slowPush);
  const run = await step(server, 'slow run', 'run_flow', { graph_id: slowPush.data?.graphId ?? -1 });
  await sleep(8000);
  await step(server, 'stop session', 'stop_session', { session_id: run.data?.session_id ?? -1 });
  const stopped = await waitForSession(server, run.data?.session_id ?? -1, 90_000);
  const status = stopped.data?.status;
  assertion(`slow session stopped (status=${status})`, 'stop_session', status === 'stop' || status === 'error' || status === 'expired', `status=${status}`);
}

// pull / dump / restore (issue 9)
{
  const pulled = join(RUN_DIR, 'pulled-core');
  await step(server, 'pull core', 'pull_flow', { graph_id: coreId, target_dir: pulled }, (response) =>
    (response.ok && existsSync(join(pulled, 'flow.yaml'))) || failure(response),
  );
  await step(server, 'pulled flow builds', 'build_flow', { flow_dir: pulled });
  await step(server, 'pulled flow diffs clean against remote', 'diff_flow', { flow_dir: pulled }, (response) =>
    (response.ok && response.data.graph.conflict === null) || failure(response),
  );
  const dumpPath = join(RUN_DIR, 'core-dump.json');
  await step(server, 'dump core', 'dump_graph', { graph_id: coreId, output_path: dumpPath }, (response) =>
    (response.ok && existsSync(dumpPath)) || failure(response),
  );
  const restored = await step(server, '#9 restore as copy', 'restore_graph', { dump_path: dumpPath, name: `reg-core-copy-${RUN}` }, (response) =>
    (response.ok && response.data.graphId !== coreId) || json(response.data ?? response.error).slice(0, 300),
  );
  trackGraph(restored);
  await step(server, 'describe restored', 'describe_graph', { graph_id: restored.data?.graphId ?? -1 });
  await runAndVerify('#9 restored copy behaves like the original (amount=500)', restored.data?.graphId ?? -1, { amount: 500, customer: 'c_edit' }, (variables) => {
    const original = lastVariables.get('edited core runs the new code (amount=500)') ?? {};
    const comparable = (vars: Record<string, any>) => json({ tier: vars.tier, loaded: vars.loaded, score: vars.score, path: vars.path });
    return (variables.tier?.edited === true && comparable(variables) === comparable(original)) ||
      `copy ${comparable(variables)} vs original ${comparable(original)}`;
  });
}

// Chat UI (issue 11)
{
  const extract = (file: string): Record<string, unknown> => {
    const match = readFileSync(file, 'utf8').match(/var ES_CONFIG = (\{[\s\S]*?\});/);
    return match ? JSON.parse(match[1]!) : {};
  };
  const plain = join(RUN_DIR, 'chat.html');
  await step(server, '#11 chat ui embeds no API key by default', 'generate_chat_ui', { graph_id: coreId, output_path: plain, title: 'Regression' }, (response) =>
    (response.ok && response.data.embedded_api_key === false && extract(plain).apiKey === '') || failure(response),
  );
  const withKey = join(RUN_DIR, 'chat-key.html');
  await step(server, '#11 chat ui embeds the key only on request, with a warning', 'generate_chat_ui', { graph_id: coreId, output_path: withKey, embed_api_key: true }, (response) =>
    (response.ok && response.data.embedded_api_key === true && /API key/.test(response.data.warning ?? '') &&
      String(extract(withKey).apiKey ?? '').length > 0) ||
    failure(response),
  );
  rmSync(withKey, { force: true }); // contains a live key — do not leave it on disk
}

// Catalog CRUD (cleans up after itself)
{
  const agentName = `reg-agent-${RUN}`;
  const surfaceName = `reg-surface-${RUN}`;
  await step(server, 'create agent', 'create_agent', { name: agentName, instructions: 'Regression agent.', llm_config: `reg-llm-${RUN}` });
  await step(server, 'get agent', 'get_agent', { agent: agentName });
  await step(server, 'update agent', 'update_agent', { agent: agentName, description: 'updated by regression' });
  await step(server, 'delete agent', 'delete_agent', { agent: agentName });
  await step(server, 'create surface', 'create_surface', { name: surfaceName, instructions: 'Regression surface.' });
  await step(server, 'get surface', 'get_surface', { surface: surfaceName });
  await step(server, 'update surface', 'update_surface', { surface: surfaceName, description: 'updated' });
  await step(server, 'delete surface', 'delete_surface', { surface: surfaceName });
}

// Knowledge without RAG (no embedding models in this suite)
{
  const doc1 = join(RUN_DIR, 'doc1.txt');
  const doc2 = join(RUN_DIR, 'doc2.txt');
  writeFileSync(doc1, 'Regression document one.');
  writeFileSync(doc2, 'Regression document two.');
  const collectionName = `reg-collection-${RUN}`;
  const createdCollection = await step(server, 'create collection', 'create_collection', { name: collectionName, documents: [doc1] });
  let collectionId: number | undefined = createdCollection.data?.collectionId ?? createdCollection.data?.collection_id ?? createdCollection.data?.id;
  if (collectionId === undefined) {
    const listed = await server.call('list_source_collections');
    collectionId = (listed.data ?? []).find((collection: { collection_name: string }) => collection.collection_name === collectionName)?.collection_id;
  }
  const id = collectionId ?? -1;
  await step(server, 'upload document', 'upload_documents', { collection_id: id, file_paths: [doc2] });
  const documents = await step(server, 'list documents', 'list_documents', { collection_id: id }, (response) =>
    (response.ok && json(response.data).includes('doc2')) || failure(response),
  );
  await step(server, 'collection status', 'get_collection_status', { collection_id: id });
  await step(server, 'wait for collections (no RAG attached → nothing to wait for)', 'wait_for_collections', { collection_ids: [id], timeout_seconds: 10, poll_interval_seconds: 2 });
  const documentIds = (Array.isArray(documents.data) ? documents.data : documents.data?.documents ?? [])
    .map((document: { document_id?: number; id?: number }) => document.document_id ?? document.id)
    .filter((documentId: unknown): documentId is number => typeof documentId === 'number');
  await step(server, 'delete document', 'delete_documents', { document_ids: documentIds.slice(-1), collection_id: id });
  skip('attach naive RAG', 'attach_rag', 'needs an embedding model; live suite is restricted to gpt-4o-mini, no embeddings');
  skip('provision knowledge', 'provision_knowledge', 'indexes documents with an embedding model; same restriction');
  await step(server, 'delete collection', 'delete_collection', { collection_id: id });
}

// Stale lockfile (issue 1): the locked graph was deleted (here via REST, as if in the editor)
{
  const dir = flow('reg-child');
  const lock = await readLock(dir);
  const originalGraphId = lock?.graphId ?? -1;
  // REST helper on the same state dir: the key is valid and the org is set, so it writes nothing.
  await restContext().client.delete(`graphs/${originalGraphId}/`);
  created.graphs.delete(originalGraphId);
  await step(server, '#1 diff_flow announces the recreate (no bare 404)', 'diff_flow', { flow_dir: dir }, (response) =>
    (response.ok && /no longer exists/.test(response.data.graph.warning ?? '')) || response.text.slice(0, 300),
  );
  const recovered = await step(server, '#1 push after the locked graph was deleted recreates it', 'push_flow', { flow_dir: dir }, (response) =>
    (response.ok && response.data.createdGraph === true && response.data.graphId !== originalGraphId &&
      /no longer exists/.test(json(response.data.warnings))) ||
    response.text.slice(0, 300),
  );
  trackGraph(recovered);
  await step(server, '#1 ...and the next push is a clean no-op on the new graph', 'push_flow', { flow_dir: dir }, (response) =>
    (response.ok && response.data.graphId === recovered.data?.graphId && response.data.changed === false && !response.data.warnings) ||
    response.text.slice(0, 300),
  );
}

// Security round 2: a stale / foreign lockfile must never overwrite entities or graphs it does not own.
{
  const coreDir = flow('reg-core');
  const coreLock = (await readLock(coreDir))!;
  const llmKey = Object.keys(coreLock.entities).find((key) => key.startsWith('llm_configs.'))!;
  const llmName = `reg-llm-${RUN}`;
  // Full row via REST (list_llm_configs only exposes id/name/model). The helper context shares the
  // state dir but writes nothing here: the key is valid and the org is already set.
  const configOf = async () => {
    const listed = ((await server.call('list_llm_configs')).data?.configs ?? []).find(
      (config: { custom_name: string }) => config.custom_name === llmName,
    );
    if (!listed) return undefined;
    const row = await restContext().client.get<Record<string, unknown>>(`llm-configs/${listed.id}/`);
    const { updated_at: _updated, ...stable } = row;
    return stable;
  };
  const before = await configOf();

  // Foreign lockfile: its graph and llm-config ids do not exist here, but this org already has a
  // same-named llm config (the core flow's). The source asks for a different temperature.
  const foreignDir = join(FLOWS, `reg-foreign-entity-${RUN}`);
  cpSync(coreDir, foreignDir, { recursive: true });
  const foreignFile = join(foreignDir, 'flow.yaml');
  writeFileSync(
    foreignFile,
    readFileSync(foreignFile, 'utf8').replace(`name: reg-core-${RUN}`, `name: reg-foreign-entity-${RUN}`).replace('temperature: 0', 'temperature: 1.5'),
  );
  writeFileSync(
    join(foreignDir, 'flow.lock.json'),
    JSON.stringify({
      ...coreLock,
      flowName: `reg-foreign-entity-${RUN}`,
      graphId: 2_000_000_000 + Math.floor(Math.random() * 1000),
      entities: { [llmKey]: { backendId: 1_999_999_999, contentHash: 'stale' } },
    }, null, 2),
  );
  await step(server, 'sec: stale lock + same-named llm config → refused, not overwritten', 'push_flow', { flow_dir: foreignDir }, (response) =>
    (!response.ok && /already exists in this organization, and flow\.lock\.json does not point at it/.test(response.error ?? '')) ||
    response.text.slice(0, 300),
  );
  const after = await configOf();
  assertion('sec: ...the shared llm config is unchanged', 'list_llm_configs',
    before !== undefined && json(after) === json(before), `before ${json(before)} after ${json(after)}`);

  // Foreign lockfile pointing at an EXISTING, differently-named graph (here: the core graph).
  const coreBefore = await server.call('diff_flow', { flow_dir: coreDir });
  const graphDir = join(FLOWS, `reg-foreign-graph-${RUN}`);
  cpSync(flow('reg-child'), graphDir, { recursive: true });
  const graphFile = join(graphDir, 'flow.yaml');
  writeFileSync(graphFile, readFileSync(graphFile, 'utf8').replace(`name: reg-child-${RUN}`, `name: reg-foreign-graph-${RUN}`));
  writeFileSync(
    join(graphDir, 'flow.lock.json'),
    JSON.stringify({ flowName: `reg-foreign-graph-${RUN}`, graphId: coreId, saveVersion: 0, entities: {}, documents: {} }, null, 2),
  );
  await step(server, 'sec: diff_flow flags a lockfile pointing at another flow\'s graph', 'diff_flow', { flow_dir: graphDir }, (response) =>
    (response.ok && /refuse/.test(response.data.graph.wouldDo ?? '') && /Refusing to overwrite/.test(response.data.graph.conflict ?? '')) ||
    response.text.slice(0, 300),
  );
  await step(server, 'sec: push_flow (even with force) refuses to overwrite it', 'push_flow', { flow_dir: graphDir, force: true }, (response) =>
    (!response.ok && /Refusing to overwrite/.test(response.error ?? '')) || response.text.slice(0, 300),
  );
  const coreAfter = await server.call('diff_flow', { flow_dir: coreDir });
  assertion('sec: ...the other graph is untouched (save_version unchanged)', 'diff_flow',
    coreBefore.data?.graph?.remoteSaveVersion !== undefined &&
      coreAfter.data?.graph?.remoteSaveVersion === coreBefore.data?.graph?.remoteSaveVersion,
    `save_version ${coreBefore.data?.graph?.remoteSaveVersion} -> ${coreAfter.data?.graph?.remoteSaveVersion}`);
}

// Security round 3a: an existing same-named knowledge collection is never adopted by a push.
{
  const name = `reg-kc-${RUN}`;
  const seedDoc = join(RUN_DIR, 'kc-seed.txt');
  writeFileSync(seedDoc, 'Owner flow document.');
  const seeded = await step(server, 'sec: seed collection owned by "another flow"', 'create_collection', { name, documents: [seedDoc] });
  let collectionId: number | undefined = seeded.data?.collectionId ?? seeded.data?.collection_id ?? seeded.data?.id;
  if (collectionId === undefined) {
    collectionId = ((await server.call('list_source_collections')).data ?? []).find(
      (collection: { collection_name: string }) => collection.collection_name === name,
    )?.collection_id;
  }
  const id = collectionId ?? -1;
  const snapshot = async () => {
    const documents = await server.call('list_documents', { collection_id: id });
    const status = await server.call('get_collection_status', { collection_id: id });
    const list = Array.isArray(documents.data) ? documents.data : documents.data?.documents ?? [];
    return json({ documents: list.map((document: { file_name?: string; document_id?: number }) => document.document_id ?? document.file_name).sort(), rags: status.data?.availableRags ?? null });
  };
  const before = await snapshot();
  await step(server, 'sec: flow with a same-named collection is refused', 'push_flow', { flow_dir: flow('reg-knowledge') }, (response) =>
    (!response.ok && /knowledge collection named ".*" already exists in this organization, and flow\.lock\.json does not point at it/.test(response.error ?? '')) ||
    response.text.slice(0, 300),
  );
  const after = await snapshot();
  assertion('sec: ...no document uploaded and no RAG attached to that collection', 'list_documents', after === before, `before ${before} after ${after}`);
  const sameNamed = ((await server.call('list_source_collections')).data ?? []).filter(
    (collection: { collection_name: string }) => collection.collection_name.startsWith(name),
  );
  assertion('sec: ...and no "(1)" duplicate collection was created', 'list_source_collections', sameNamed.length === 1, json(sameNamed.map((collection: { collection_name: string }) => collection.collection_name)));
  await step(server, 'sec: cleanup seeded collection', 'delete_collection', { collection_id: id });
}

// Security round 3b: a copied flow dir (lockfile included) with a new meta.name must not take over
// the original's graph; rename: true is the explicit opt-in.
{
  const originalDir = flow('reg-slow');
  const original = await readLock(originalDir);
  const originalGraphId = original?.graphId ?? -1;
  const originalBefore = await server.call('diff_flow', { flow_dir: originalDir });
  const copyDir = join(FLOWS, `reg-slow-copy-${RUN}`);
  cpSync(originalDir, copyDir, { recursive: true });
  const copyFile = join(copyDir, 'flow.yaml');
  writeFileSync(copyFile, readFileSync(copyFile, 'utf8').replace(`name: reg-slow-${RUN}`, `name: reg-slow-copy-${RUN}`));
  await step(server, 'sec: copied flow dir with a new meta.name is refused', 'push_flow', { flow_dir: copyDir, force: true }, (response) =>
    (!response.ok && /this flow source is named "reg-slow-copy-/.test(response.error ?? '') && /rename: true/.test(response.error ?? '')) ||
    response.text.slice(0, 300),
  );
  const originalAfter = await server.call('diff_flow', { flow_dir: originalDir });
  assertion('sec: ...the original graph is untouched (name + save_version)', 'diff_flow',
    originalAfter.ok && originalAfter.data.graph.conflict === null &&
      originalAfter.data.graph.remoteSaveVersion === originalBefore.data?.graph?.remoteSaveVersion,
    json(originalAfter.data?.graph ?? originalAfter.error));

  // Explicit rename of the ORIGINAL directory's flow.
  const renamedName = `reg-slow-renamed-${RUN}`;
  const originalFile = join(originalDir, 'flow.yaml');
  writeFileSync(originalFile, readFileSync(originalFile, 'utf8').replace(`name: reg-slow-${RUN}`, `name: ${renamedName}`));
  await step(server, 'sec: rename: true renames the remote graph', 'push_flow', { flow_dir: originalDir, rename: true }, (response) =>
    (response.ok && response.data.graphId === originalGraphId && /Renamed graph/.test(json(response.data.warnings))) || response.text.slice(0, 300),
  );
  const graphs = await server.call('list_graphs');
  assertion('sec: ...graph and lockfile carry the new name', 'list_graphs',
    json(graphs.data).includes(`"${renamedName}"`) && (await readLock(originalDir))?.flowName === renamedName,
    `lock flowName ${(await readLock(originalDir))?.flowName}`);
  await step(server, 'sec: ...and a plain repush afterwards is a no-op', 'push_flow', { flow_dir: originalDir }, (response) =>
    (response.ok && response.data.changed === false) || response.text.slice(0, 300),
  );
}

// Coverage tools (venvs, versions, recycle bin, configs, secrets, key-value tables, tool catalog,
// labels, import/export, persistent state). Everything is named reg-cov-<run> and removed here; the
// flow's python code is moved back to the default venv before anything is copied, versioned or
// binned, so the venv can be deleted at the end (binned code would still hold it).
{
  const prefix = `reg-cov-${RUN}`;
  const binned: Array<{ kind: string; id: number }> = [];
  const binnedId = (kind: string, response: ToolResponse): void => {
    if (response.ok && typeof response.data?.deleted?.id === 'number') binned.push({ kind, id: response.data.deleted.id });
  };

  const settings = await step(server, 'cov: get_settings', 'get_settings', {}, (response) =>
    (response.ok && response.data.execution_timeout_limits.default_seconds > 0 && typeof response.data.recycle_bin_retention_days === 'number') ||
    failure(response),
  );
  await step(server, 'cov: list_venvs', 'list_venvs');
  const venv = await step(server, 'cov: create_venv (requirement strings)', 'create_venv', { name: prefix, libraries: ['six'] }, (response) =>
    (response.ok && response.data.venv.name === prefix) || failure(response),
  );
  const venvId: number | undefined = venv.data?.venv?.id;
  await step(server, 'cov: update_venv replaces the library list', 'update_venv', { venv: prefix, libraries: ['six>=1.16'] }, (response) =>
    (response.ok && response.data.venv.libraries[0].startsWith('six>=1.16')) || failure(response),
  );

  const dir = join(FLOWS, `reg-cov-flow-${RUN}`);
  mkdirSync(dir, { recursive: true });
  const flowYaml = (venvValue: string): string => `meta:
  name: reg-cov-flow-${RUN}
tools:
  python_code_tools:
    reg-cov-tool-${RUN}:
      description: Coverage tool.
      venv: ${venvValue}
      code: |
        def main():
            return 1
flow:
  nodes:
    start: { type: start }
    crunch:
      type: python
      venv: ${venvValue}
      code: |
        def main():
            return {"ok": True}
      output_variable_path: variables.result
    finish: { type: end }
  edges:
    - { from: start, to: crunch }
    - { from: crunch, to: finish }
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml(prefix));
  const pushed = await step(server, 'cov: push_flow resolves venv: by name', 'push_flow', { flow_dir: dir }, (response) =>
    (response.ok && response.data.entities.some((action: { kind: string; backendId: number }) => action.kind === 'venv' && action.backendId === venvId)) ||
    failure(response),
  );
  trackGraph(pushed);
  const flowId: number = pushed.data?.graphId ?? -1;
  const flowTool = (pushed.data?.entities ?? []).find((action: { kind: string }) => action.kind === 'python_code_tool');
  await step(server, 'cov: describe_graph shows venv_id, node_number and authorship', 'describe_graph', { graph_id: flowId }, (response) => {
    const python = response.data?.nodes?.python_node_list?.[0];
    return (response.ok && python?.venv_id === venvId && typeof python?.node_number === 'number' && 'created_by' in response.data && 'created_by' in python) ||
      json(response.data ?? response.error).slice(0, 300);
  });
  await step(server, 'cov: repush with venv unchanged is a no-op', 'push_flow', { flow_dir: dir }, (response) =>
    (response.ok && response.data.changed === false) || json(response.data ?? response.error).slice(0, 300),
  );
  const pulledDir = join(FLOWS, `reg-cov-pulled-${RUN}`);
  await step(server, 'cov: pull_flow writes venv: and reports authorship', 'pull_flow', { graph_id: flowId, target_dir: pulledDir }, (response) =>
    (response.ok && readFileSync(join(pulledDir, 'flow.yaml'), 'utf8').includes(`venv: ${prefix}`) &&
      response.data.authorship.nodes.some((node: { name: string; node_number: unknown }) => node.name === 'crunch' && typeof node.node_number === 'number')) ||
    failure(response),
  );
  await step(server, 'cov: the pulled source repushes as a no-op', 'push_flow', { flow_dir: pulledDir }, (response) =>
    (response.ok && response.data.changed === false) || json(response.data ?? response.error).slice(0, 300),
  );
  writeFileSync(join(dir, 'flow.yaml'), flowYaml('null'));
  await step(server, 'cov: venv: null moves the code back to the default venv', 'push_flow', { flow_dir: dir }, (response) =>
    (response.ok && response.data.changed === true) || failure(response),
  );

  // Versions, copy, export / import, labels, persistent state.
  const version = await step(server, 'cov: create_graph_version', 'create_graph_version', { graph_id: flowId, name: `${prefix}-v1` });
  await step(server, 'cov: list_graph_versions', 'list_graph_versions', { graph_id: flowId }, (response) =>
    (response.ok && response.data.some((row: { id: number }) => row.id === version.data?.version?.id)) || failure(response),
  );
  await step(server, 'cov: restore_graph_version in place (with backup)', 'restore_graph_version', { version_id: version.data?.version?.id ?? -1 }, (response) =>
    (response.ok && response.data.restored === true && response.data.auto_backup_version_id != null) || failure(response),
  );
  const fromVersion = await step(server, 'cov: restore_graph_version as a new flow', 'restore_graph_version', { version_id: version.data?.version?.id ?? -1, mode: 'new_flow' });
  if (typeof fromVersion.data?.graph_id === 'number') created.graphs.add(fromVersion.data.graph_id);
  await step(server, 'cov: get_flow_persistent_state', 'get_flow_persistent_state', { graph_id: flowId }, (response) =>
    (response.ok && response.data.graphId === flowId) || failure(response),
  );
  trackGraph(await step(server, 'cov: copy_flow', 'copy_flow', { graph_id: flowId, name: `${prefix}-copy` }));
  const exportPath = join(RUN_DIR, 'cov-export.json');
  await step(server, 'cov: export_entities', 'export_entities', { kind: 'flow', ids: [flowId], output_path: exportPath }, (response) =>
    (response.ok && existsSync(exportPath)) || failure(response),
  );
  await step(server, 'cov: import_entities inspect_only', 'import_entities', { kind: 'flow', file_path: exportPath, inspect_only: true });
  const graphsBefore = new Set(((await server.call('list_graphs')).data ?? []).map((graph: { id: number }) => graph.id));
  await step(server, 'cov: import_entities', 'import_entities', { kind: 'flow', file_path: exportPath });
  for (const graph of ((await server.call('list_graphs')).data ?? []) as Array<{ id: number }>) {
    if (!graphsBefore.has(graph.id)) created.graphs.add(graph.id);
  }
  const flowLabel = await step(server, 'cov: create_label (flow)', 'create_label', { scope: 'flow', name: `${prefix}-flow`, color: 'green' });
  await step(server, 'cov: set_flow_labels', 'set_flow_labels', { graph_id: flowId, labels: [`${prefix}-flow`] }, (response) =>
    (response.ok && response.data.label_ids.includes(flowLabel.data?.id)) || failure(response),
  );
  await step(server, 'cov: update_label', 'update_label', { scope: 'flow', label: `${prefix}-flow`, color: 'blue' });
  await step(server, 'cov: list_labels', 'list_labels', { scope: 'flow' }, (response) =>
    (response.ok && response.data.some((label: { id: number; color: string }) => label.id === flowLabel.data?.id && label.color === 'blue')) || failure(response),
  );

  // Tool catalog + recycle bin.
  const toolLabel = await step(server, 'cov: create_label (tool)', 'create_label', { scope: 'tool', name: `${prefix}-tool` });
  const pyTool = await step(server, 'cov: create_python_tool (venv + label)', 'create_python_tool', {
    name: `${prefix}-py`, description: 'Coverage tool.', code: 'def main():\n    return 1', venv: prefix, labels: [`${prefix}-tool`],
  });
  const pyToolId: number = pyTool.data?.tool?.id ?? -1;
  await step(server, 'cov: update_python_tool (venv null, timeout)', 'update_python_tool', { tool: pyToolId, venv: null, execution_timeout: 60 }, (response) =>
    (response.ok && response.data.tool.venv_id === null) || failure(response),
  );
  await step(server, 'cov: delete_python_tool → recycle bin', 'delete_python_tool', { tool: pyToolId });
  await step(server, 'cov: list_recycle_bin (one kind, search)', 'list_recycle_bin', { kind: 'python_tool', search: prefix }, (response) =>
    (response.ok && response.data.items.some((item: { id: number }) => item.id === pyToolId)) || failure(response),
  );
  await step(server, 'cov: restore_from_recycle_bin', 'restore_from_recycle_bin', { kind: 'python_tool', ids: [pyToolId] }, (response) =>
    (response.ok && response.data.restored.some((item: { id: number }) => item.id === pyToolId)) || failure(response),
  );
  binnedId('python_tool', await step(server, 'cov: delete the python tool again', 'delete_python_tool', { tool: pyToolId }));
  if (flowTool) binnedId('python_tool', await step(server, 'cov: delete the flow\'s python tool', 'delete_python_tool', { tool: flowTool.backendId }));
  const mcpTool = await step(server, 'cov: create_mcp_tool', 'create_mcp_tool', {
    name: `${prefix}-mcp`, transport: 'http://127.0.0.1:9/mcp', tool_name: 'noop', labels: [toolLabel.data?.id ?? -1],
  });
  await step(server, 'cov: update_mcp_tool', 'update_mcp_tool', { tool: mcpTool.data?.tool?.id ?? -1, timeout: 45 }, (response) =>
    (response.ok && response.data.tool.timeout === 45) || failure(response),
  );
  binnedId('mcp_tool', await step(server, 'cov: delete_mcp_tool', 'delete_mcp_tool', { tool: mcpTool.data?.tool?.id ?? -1 }));
  await step(server, 'cov: delete_label (tool)', 'delete_label', { scope: 'tool', label: `${prefix}-tool` });
  await step(server, 'cov: delete_label (flow)', 'delete_label', { scope: 'flow', label: `${prefix}-flow` });

  // Secrets and model configuration. The secret value comes from the suite's provider key env.
  await step(server, 'cov: list_secrets', 'list_secrets');
  const secret = await step(server, 'cov: create_secret from an env var (value never echoed)', 'create_secret', { name: `${prefix}-secret`, value_env: 'STRESS_OPENAI_KEY' }, (response) =>
    (response.ok && !response.text.includes(process.env.STRESS_OPENAI_KEY ?? '\u0000') && !('tail' in response.data.secret)) || failure(response),
  );
  const llm = await step(server, 'cov: create_llm_config (key by secret name)', 'create_llm_config', {
    name: `${prefix}-llm`, model: MODEL, provider: PROVIDER, api_key_secret: `${prefix}-secret`, temperature: 0.2,
  }, (response) => (response.ok && response.data.config.api_key_secret_id === secret.data?.secret?.id) || failure(response));
  await step(server, 'cov: update_llm_config', 'update_llm_config', { config: `${prefix}-llm`, temperature: 0.5 }, (response) =>
    (response.ok && response.data.config.temperature === 0.5) || failure(response),
  );
  await step(server, 'cov: delete_llm_config dry_run deletes nothing', 'delete_llm_config', { config: `${prefix}-llm`, dry_run: true }, (response) =>
    (response.ok && response.data.dry_run === true && response.data.deleted_ids.length === 0) || failure(response),
  );
  await step(server, 'cov: delete_llm_config', 'delete_llm_config', { config: llm.data?.config?.id ?? -1 });
  const embeddings = await step(server, 'cov: list_embedding_configs include_models', 'list_embedding_configs', { include_models: true });
  const embeddingModel = embeddings.data?.models?.[0];
  if (embeddingModel) {
    await step(server, 'cov: create_embedding_config', 'create_embedding_config', { name: `${prefix}-embed`, model: embeddingModel.id, api_key_secret: `${prefix}-secret` });
    await step(server, 'cov: update_embedding_config', 'update_embedding_config', { config: `${prefix}-embed`, is_visible: false });
    await step(server, 'cov: delete_embedding_config', 'delete_embedding_config', { config: `${prefix}-embed` });
  } else {
    for (const tool of ['create_embedding_config', 'update_embedding_config', 'delete_embedding_config']) skip('cov: embedding configs', tool, 'no embedding model on this instance');
  }
  binnedId('secret', await step(server, 'cov: delete_secret', 'delete_secret', { secret: `${prefix}-secret` }));
  // A no-op write: the current value is sent back, so the org's defaults never change.
  const memoryLlm = settings.data?.default_models?.memory_llm_config?.id ?? null;
  await step(server, 'cov: update_default_models (current value re-sent)', 'update_default_models', { memory_llm_config: memoryLlm }, (response) =>
    (response.ok && response.data.memory_llm_config === memoryLlm) || failure(response),
  );
  skip('cov: quickstart', 'run_quickstart', 'creates backend-named configs (and possibly realtime ones) the suite cannot attribute and remove');

  // Key-value tables.
  const table = await step(server, 'cov: create_key_value_table', 'create_key_value_table', { name: `${prefix}-kv` });
  const tableId: number = table.data?.id ?? -1;
  await step(server, 'cov: write_key_value_entries', 'write_key_value_entries', { table: tableId, set: { alpha: { n: 1 }, beta: 'b' }, delete: ['beta'] }, (response) =>
    (response.ok && response.data.created.length === 2 && response.data.deleted[0] === 'beta') || failure(response),
  );
  await step(server, 'cov: list_key_value_entries (one key, full value)', 'list_key_value_entries', { table: tableId, key: 'alpha' }, (response) =>
    (response.ok && response.data.entry.value.n === 1) || failure(response),
  );
  await step(server, 'cov: list_key_value_tables', 'list_key_value_tables', {}, (response) =>
    (response.ok && response.data.some((row: { id: number }) => row.id === tableId)) || failure(response),
  );
  await step(server, 'cov: update_key_value_table', 'update_key_value_table', { table: tableId, description: 'coverage' });
  binnedId('key_value_table', await step(server, 'cov: delete_key_value_table', 'delete_key_value_table', { table: tableId }));
  await step(server, 'cov: list_recycle_bin (every bin)', 'list_recycle_bin', {}, (response) =>
    (response.ok && typeof response.data.retention_days === 'number') || failure(response),
  );

  // The flow itself: delete → bin → restore; the D cleanup deletes it again.
  await step(server, 'cov: delete_flow', 'delete_flow', { graph_id: flowId });
  await step(server, 'cov: restore the flow', 'restore_from_recycle_bin', { kind: 'flow', ids: [flowId] });

  // Purge only what this block binned. Superadmin-only upstream: anyone else gets the explanation.
  for (const kind of [...new Set(binned.map((item) => item.kind))]) {
    const ids = binned.filter((item) => item.kind === kind).map((item) => item.id);
    const purged = await server.call('purge_from_recycle_bin', { kind, ids, confirm: true });
    if (!purged.ok && /only a superadmin/.test(purged.error ?? '')) {
      record('cov: purge own binned items', 'purge_from_recycle_bin', 'SKIP', purged.ms, 'the test user is not a superadmin');
      break;
    }
    record(`cov: purge own binned ${kind}`, 'purge_from_recycle_bin', purged.ok && purged.data.failed.length === 0 ? 'PASS' : 'FAIL', purged.ms,
      purged.ok ? json(purged.data.failed) : failure(purged));
  }
  await step(server, 'cov: delete_venv (no code runs in it any more)', 'delete_venv', { venv: venvId ?? -1 });
}

await server.close();

// ---------------------------------------------------------------------------------------------
// C. Process-level auth / org behaviour (issues 5, 10, 13) — fresh server processes
// ---------------------------------------------------------------------------------------------

// #10: a fresh process resolves the org itself before org-scoped calls (no check_connection).
{
  restContext().store.update({ activeOrgId: null });
  const fresh = await Server.start(process.env);
  await step(fresh, '#10 fresh process: org-scoped get_session works without check_connection', 'get_session', { session_id: goldSession }, (response) =>
    (response.ok && response.data.id === goldSession) || failure(response),
  );
  await fresh.close();
  restContext().store.update({ activeOrgId: null });
  const freshAgain = await Server.start(process.env);
  await step(freshAgain, '#10 fresh process: entity tool (diff_flow) resolves the org itself', 'diff_flow', { flow_dir: flow('reg-core') }, (response) =>
    (response.ok && response.data.graph.graphId === coreId) || failure(response),
  );
  await freshAgain.close();
}

// #13: repeated bootstraps with a valid stored key mint nothing.
{
  const before = (await listApiKeys()).filter((key) => !key.revoked);
  for (let launch = 1; launch <= 3; launch += 1) {
    const fresh = await Server.start(process.env);
    await fresh.call('list_graphs');
    const minted = /Minted API key/.test(fresh.log) || /Logging in/.test(fresh.log);
    await fresh.close();
    if (minted) {
      assertion(`#13 bootstrap ${launch} reused the stored key`, 'check_connection', false, 'server minted a key / logged in');
    }
  }
  const after = (await listApiKeys()).filter((key) => !key.revoked);
  assertion('#13 three fresh processes minted zero keys', 'check_connection', after.length === before.length, `active keys ${before.length} -> ${after.length}`);
}

// #5: the stored API key no longer works; the stored JWT session mints the replacement — no login.
// If this run minted the stored key, it is revoked on the server (ours to revoke — and it keeps
// the run within ONE extra key slot); a pre-existing key is only invalidated locally (never
// revoked) and restored at cleanup. Either way the replacement is revoked again in cleanup.
{
  const context = restContext();
  const state = context.store.get();
  const keysBefore = await listApiKeys();
  const ownStoredKey =
    state.keyPrefix && state.keyPrefix !== initialKey?.keyPrefix
      ? keysBefore.find((key) => !key.revoked && key.prefix === state.keyPrefix)
      : undefined;
  if (ownStoredKey) {
    await withUserSession((session, bearerToken) =>
      session.client.post(`profile/api-keys/${ownStoredKey.id}/revoke/`, { bearerToken }),
    );
  } else {
    context.store.update({ apiKey: 'es-regression-invalid-key', keyPrefix: 'es-regre' });
  }
  const activeBefore = (await listApiKeys()).filter((key) => !key.revoked).length;
  const fresh = await Server.start(process.env);
  await step(fresh, '#5 invalid stored key: reconnects with a new key', 'check_connection', {}, (result) =>
    (result.ok && result.data.authMode === 'api-key' && result.data.apiKeyPrefix !== state.keyPrefix) || failure(result),
  );
  assertion('#5 ...minted through the stored session, without a login', 'check_connection',
    /Minted API key/.test(fresh.log) && !/Logging in/.test(fresh.log), 'expected a mint and no login in the server log');
  await fresh.close();
  const activeAfter = (await listApiKeys()).filter((key) => !key.revoked).length;
  assertion('#5 exactly one key minted', 'check_connection', activeAfter === activeBefore + 1, `active keys ${activeBefore} -> ${activeAfter}`);
}

// ---------------------------------------------------------------------------------------------
// D. Cleanup (graphs + flow-created entities; catalog/knowledge steps cleaned up via their tools)
// ---------------------------------------------------------------------------------------------

if (process.env.REG_KEEP !== '1') {
  // A stored key known to be dead (e.g. a failed #5) would make every cleanup call try to mint.
  if (restContext().store.get().apiKey === 'es-regression-invalid-key' && initialKey) {
    restContext().store.update({ apiKey: initialKey.apiKey, keyPrefix: initialKey.keyPrefix });
  }
  const context = restContext();
  const failures: string[] = [];
  const remove = async (path: string): Promise<void> => {
    await context.client.delete(path).catch((error: Error) => failures.push(`${path}: ${error.message}`));
  };
  for (const graphId of created.graphs) await remove(`graphs/${graphId}/`);
  const core = await readLock(flow('reg-core'));
  const flowEntities = [...Object.entries(core?.entities ?? {}), ...concurrentEntities];
  for (const [key, entry] of flowEntities) {
    if (key.startsWith('agents.')) await remove(`agent-definitions/${entry.backendId}/`);
  }
  for (const [key, entry] of flowEntities) {
    if (key.startsWith('llm_configs.')) await remove(`llm-configs/${entry.backendId}/`);
  }
  console.log(`cleanup: ${created.graphs.size} graph(s) + core entities removed${failures.length ? `; ${failures.length} failed: ${failures.join('; ')}` : ''}`);

  // API keys this run minted (every stored prefix except the one the state dir started with).
  const minted = [...seenKeyPrefixes].filter((prefix) => prefix !== initialKey?.keyPrefix);
  const ours = (await listApiKeys()).filter((key) => !key.revoked && minted.includes(key.prefix));
  for (const key of ours) {
    await withUserSession((session, bearerToken) =>
      session.client.post(`profile/api-keys/${key.id}/revoke/`, { bearerToken }),
    ).catch((error: Error) => failures.push(`revoke key #${key.id}: ${error.message}`));
  }
  // Put the pre-existing key back so the next run reuses it instead of minting.
  if (initialKey) restContext().store.update({ apiKey: initialKey.apiKey, keyPrefix: initialKey.keyPrefix });
  else restContext().store.update({ apiKey: null, keyPrefix: null });
  const activeAtEnd = (await listApiKeys()).filter((key) => !key.revoked).length;
  console.log(`cleanup: revoked ${ours.length} API key(s) minted by this run; ${activeAtEnd} active key(s) remain for this user`);
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const allTools = (await (async () => {
  const listing = await Server.start(process.env);
  const { tools } = await listing.client.listTools();
  await listing.close();
  return tools.map((tool) => tool.name);
})());
const unexercised = allTools.filter((name) => !exercised.has(name));
if (unexercised.length > 0) record('every tool exercised', 'listTools', 'FAIL', 0, `never called: ${unexercised.join(', ')}`);

const count = (verdict: Verdict): number => rows.filter((row) => row.verdict === verdict).length;
writeFileSync(join(RUN_DIR, 'results.json'), JSON.stringify({ run: RUN, rows, exercised: [...exercised].sort() }, null, 2));
console.log(`\n==== PASS ${count('PASS')}  FAIL ${count('FAIL')}  SKIP ${count('SKIP')}  | tools exercised ${allTools.length - unexercised.length}/${allTools.length} | results: ${join(RUN_DIR, 'results.json')}`);
process.exit(count('FAIL') > 0 ? 1 : 0);
