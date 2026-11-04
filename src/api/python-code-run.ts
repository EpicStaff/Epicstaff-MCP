import type { ApiClient } from '../http/client.js';
import { ApiError } from '../http/errors.js';

/**
 * Code-only test runs of a node's stored Python code — ported from frontend
 * `visual-programming/services/python-code-run.service.ts` (`PythonCodeRunService`: run-python-code,
 * python-code-result polling, a python node's last session input).
 *
 * Backend: RunPythonCodeAPIView (`POST run-python-code/`, FLOWS UPDATE; a trigger node's code also
 * needs FLOWS USE), PythonCodeResultReadViewSet (`GET python-code-result/<execution_id>/`, org-scoped,
 * 404 for another org's run) and PythonNodeLastTestInputView (`GET pythonnodes/<id>/last-session-input/`).
 * The run executes the code the backend has STORED for the node — unsaved local edits are not run.
 */

/** The kinds of node whose stored Python code run-python-code can run (backend CODE_RUN_TARGETS). */
export type PythonCodeRunTargetType = 'python_node' | 'webhook_trigger_node';

/** A saved node, by its backend id: the backend resolves the code it runs (and the node's storage) from it. */
export interface PythonCodeRunTarget {
  type: PythonCodeRunTargetType;
  id: number;
}

export interface RunPythonCodeRequest {
  target: PythonCodeRunTarget;
  variables: Record<string, unknown>;
}

export type PythonCodeExecutionStatus = 'pending' | 'completed' | 'error';

export interface PythonCodeResult {
  execution_id: string;
  status: PythonCodeExecutionStatus;
  result_data: string | null;
  returncode: number | null;
  stderr: string;
  stdout: string;
  created_at?: string;
  finished_at?: string | null;
}

/** `GET pythonnodes/<id>/last-session-input/`: the node's input in the newest ended session, or null. */
export interface PythonNodeLastSessionInput {
  detail: string;
  input: Record<string, unknown> | null;
}

/** Poll cadence and limits for python-code-result (the frontend's constants). */
export const POLL_INITIAL_DELAY_MS = 1000;
export const POLL_INTERVAL_MS = 2000;
/** How long past the code's execution timeout to wait: queueing, installing the libraries and publishing the result come on top. */
export const POLL_DEADLINE_GRACE_MS = 60_000;
/** A freshly started run's result row may not exist yet: that many 404s in a row are waited out. */
export const MAX_NOT_FOUND_RETRIES = 3;

export class PythonCodeRunApi {
  constructor(private readonly client: ApiClient) {}

  async runPythonCode(request: RunPythonCodeRequest): Promise<{ execution_id: string }> {
    return this.client.post<{ execution_id: string }>('run-python-code/', { body: request });
  }

  async getResult(executionId: string): Promise<PythonCodeResult> {
    return this.client.get<PythonCodeResult>(`python-code-result/${encodeURIComponent(executionId)}/`);
  }

  async getLastTestInput(pythonNodeId: number): Promise<PythonNodeLastSessionInput> {
    return this.client.get<PythonNodeLastSessionInput>(`pythonnodes/${pythonNodeId}/last-session-input/`);
  }
}

export interface PollTiming {
  initialDelayMs: number;
  intervalMs: number;
  graceMs: number;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
}

const DEFAULT_TIMING: PollTiming = {
  initialDelayMs: POLL_INITIAL_DELAY_MS,
  intervalMs: POLL_INTERVAL_MS,
  graceMs: POLL_DEADLINE_GRACE_MS,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => Date.now(),
};

/** How a poll ended: the finished result, or still pending when the wait ran out. */
export type PollOutcome =
  | { finished: true; result: PythonCodeResult }
  | { finished: false; lastStatus: PythonCodeExecutionStatus | 'not_found_yet' };

/**
 * Poll the result of run `executionId` until it is no longer pending, giving up a grace period after
 * the code's `executionTimeoutSeconds` (`pollResultWithEvents`). A 404 right after the start is the
 * result row not written yet and is retried {@link MAX_NOT_FOUND_RETRIES} times; a later 404 means
 * the run is not in the active organization.
 */
export async function pollPythonCodeResult(
  api: Pick<PythonCodeRunApi, 'getResult'>,
  executionId: string,
  executionTimeoutSeconds: number,
  timing: Partial<PollTiming> = {},
): Promise<PollOutcome> {
  const { initialDelayMs, intervalMs, graceMs, sleep, now } = { ...DEFAULT_TIMING, ...timing };
  const deadline = now() + executionTimeoutSeconds * 1000 + graceMs;
  let notFoundRetries = 0;
  let lastStatus: PythonCodeExecutionStatus | 'not_found_yet' = 'not_found_yet';

  await sleep(initialDelayMs);
  for (;;) {
    try {
      const result = await api.getResult(executionId);
      // A successful read means the record exists; reset the create-race counter.
      notFoundRetries = 0;
      if (result.status !== 'pending') return { finished: true, result };
      lastStatus = result.status;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      notFoundRetries += 1;
      if (notFoundRetries > MAX_NOT_FOUND_RETRIES) {
        throw new Error(
          `Execution result ${executionId} not found in the active organization. It may belong to a different ` +
            'organization or have been removed.',
        );
      }
    }
    if (now() + intervalMs > deadline) return { finished: false, lastStatus };
    await sleep(intervalMs);
  }
}
