/**
 * Stress-test harness — drives the plugin's own compile → push → run → verify
 * pipeline against a live backend, reusing the exact code paths the MCP tools use
 * (compileFlow, EntityPusher, GraphPusher, SessionsApi). Temporary; delete when done.
 */
import { loadConfig } from '../src/config.js';
import { createContext, type AppContext } from '../src/context.js';
import { compileFlow } from '../src/compiler/index.js';
import { hasErrors } from '../src/flow-source/diagnostics.js';
import { createLock, readLock, writeLock } from '../src/flow-source/lockfile.js';
import { EntityPusher } from '../src/pusher/entities.js';
import { GraphPusher } from '../src/pusher/graph.js';
import { SessionsApi, TERMINAL_SESSION_STATUSES, summarizeMessages } from '../src/api/sessions.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function connect(): Promise<AppContext> {
  const context = createContext(loadConfig());
  await context.auth.ensureAuthenticated();
  const org = await context.org.resolve();
  if (org.activeOrgId === null) {
    if (org.organizations.length === 0) throw new Error('no organizations for this user');
    await context.org.setActive(org.organizations[0]!.id);
  }
  return context;
}

export interface CompileResult {
  flowName: string;
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
  startDomain: Record<string, unknown> | null;
  producedRoots: string[];
}

export async function compile(dir: string): Promise<CompileResult> {
  const artifact = await compileFlow(dir);
  const errors = artifact.diagnostics
    .filter((d) => d.severity === 'error')
    .map((d) => ({ path: d.path, message: d.message }));
  const warnings = artifact.diagnostics
    .filter((d) => d.severity === 'warning')
    .map((d) => ({ path: d.path, message: d.message }));
  const start = artifact.graph.nodes.find((n) => n.type === 'start') as
    | { data: { initialState: Record<string, unknown> } }
    | undefined;
  // Unwrap the native scheme {variables, persistent_variables} → the actual domain.
  const rawStart = start ? start.data.initialState : null;
  const startDomain =
    rawStart && rawStart.variables && typeof rawStart.variables === 'object'
      ? (rawStart.variables as Record<string, unknown>)
      : rawStart;
  // Top-level roots any node writes via output_variable_path — must all be in the domain.
  const producedRoots = [
    ...new Set(
      artifact.graph.nodes
        .map((n) => (n as { output_variable_path?: string | null }).output_variable_path)
        .filter((p): p is string => typeof p === 'string' && p.startsWith('variables.'))
        .map((p) => p.split('|')[0]!.split('.')[1]!)
        .filter(Boolean),
    ),
  ];
  return { flowName: artifact.flowName, errors, warnings, startDomain, producedRoots };
}

export async function push(context: AppContext, dir: string): Promise<{ graphId: number; saveVersion: number }> {
  const artifact = await compileFlow(dir);
  if (hasErrors(artifact.diagnostics)) throw new Error(`compile errors in ${dir}`);
  let lock = (await readLock(dir)) ?? createLock(artifact.flowName);
  const entityPusher = new EntityPusher(context);
  const entityResult = await entityPusher.push(artifact, lock);
  lock = entityResult.lock;
  await writeLock(dir, lock);
  const graphPusher = new GraphPusher(context);
  const graphResult = await graphPusher.push(artifact, lock, entityResult.idMap, {
    force: true,
    persistLock: (partial) => writeLock(dir, partial),
  });
  lock = graphResult.lock;
  await writeLock(dir, lock);
  return { graphId: graphResult.graphId, saveVersion: graphResult.saveVersion };
}

export interface RunResult {
  sessionId: number;
  status: string;
  finalReply: unknown;
  finalVariables: Record<string, unknown> | null;
  errorData: unknown;
  timeline: { role: string; text: string }[];
}

export async function run(
  context: AppContext,
  graphId: number,
  initialState: Record<string, unknown>,
  { pollMs = 3000, maxPolls = 80 }: { pollMs?: number; maxPolls?: number } = {},
): Promise<RunResult> {
  const sessions = new SessionsApi(context.client);
  const { session_id } = await sessions.runGraph(graphId, initialState);
  let status = 'pending';
  for (let i = 0; i < maxPolls; i++) {
    const updates = await sessions.getSessionUpdates(session_id);
    status = updates.status;
    if (TERMINAL_SESSION_STATUSES.has(status) || status === 'wait_for_user') break;
    await sleep(pollMs);
  }
  const page = await sessions.getSessionMessages(session_id, 200, 0);
  const summary = summarizeMessages(page.results) as {
    final_reply?: unknown;
    final_variables?: Record<string, unknown> | null;
    messages?: { role?: string; text?: string }[];
  };
  const session = await sessions.getSession(session_id);
  return {
    sessionId: session_id,
    status,
    finalReply: summary.final_reply ?? null,
    finalVariables: summary.final_variables ?? null,
    errorData: (session as { status_data?: unknown }).status_data ?? null,
    timeline: (summary.messages ?? []).map((m) => ({ role: m.role ?? '?', text: (m.text ?? '').slice(0, 200) })),
  };
}
