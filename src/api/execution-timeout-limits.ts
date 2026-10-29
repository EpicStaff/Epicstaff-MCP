import type { ApiClient } from '../http/client.js';

/**
 * Execution timeout limits — ported from
 * shared/services/execution-timeout-limits/execution-timeout-limits-api.service.ts and
 * shared/models/execution-timeout-limits.model.ts. Deployment-wide, not org-scoped
 * (ExecutionTimeoutLimitsAPIView): the bounds python code's `execution_timeout` is validated against.
 */
export interface ExecutionTimeoutLimits {
  min_seconds: number;
  /** Execution timeout a new python code gets. */
  default_seconds: number;
  /** Largest execution timeout; a higher value is saved as this. Null: no limit. */
  max_seconds: number | null;
}

export class ExecutionTimeoutLimitsApi {
  constructor(private readonly client: ApiClient) {}

  async get(): Promise<ExecutionTimeoutLimits> {
    return this.client.get<ExecutionTimeoutLimits>('execution-timeout-limits/');
  }
}
