import type { ApiClient } from '../http/client.js';
import { withRedactedErrors } from './redaction.js';

/**
 * First-run setup of a fresh EpicStaff instance — ported from the first-setup half of frontend
 * `services/auth/auth.service.ts` (`getFirstSetupStatus`, `submitFirstSetup`). Backend:
 * rbac/views/auth.py FirstSetupView + rbac/identity/first_setup.py.
 *
 * The endpoint is anonymous. The backend guards it: the POST is refused unless
 * FIRST_SETUP_MODE=open (the default `cli_only` closes it), and refused atomically (a bootstrap lock,
 * then an existence check) once any user exists — so it can create the first superadmin exactly once.
 */

export interface FirstSetupStatus {
  /** Stays false whenever the HTTP path is closed (`setup_mode` other than `open`). */
  needs_setup: boolean;
  setup_mode: string;
}

export interface FirstSetupRequest {
  email: string;
  password: string;
  display_name?: string | null;
}

/** `FirstSetupResponseSerializer` without `access` — the session token is dropped on arrival. */
export interface FirstSetupResult {
  user: { id: number; email: string; display_name: string | null; is_superadmin: boolean };
  organization: { id: number; name: string; is_active: boolean };
}

interface FirstSetupResponse extends FirstSetupResult {
  access: string;
}

export class FirstSetupApi {
  constructor(private readonly client: ApiClient) {}

  async getStatus(): Promise<FirstSetupStatus> {
    return this.client.get<FirstSetupStatus>('auth/first-setup/', { skipAuth: true });
  }

  /**
   * Create the first superadmin and the default organization. The response's access token (and the
   * refresh cookie it sets) are discarded: the MCP signs in through its normal login afterwards.
   * The password never reaches an error message.
   */
  async complete(request: FirstSetupRequest): Promise<FirstSetupResult> {
    const response = await withRedactedErrors([{ field: 'password', value: request.password }], () =>
      this.client.post<FirstSetupResponse>('auth/first-setup/', { skipAuth: true, body: request }),
    );
    return { user: response.user, organization: response.organization };
  }
}
