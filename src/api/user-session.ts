import { ApiError } from '../http/errors.js';

/**
 * A user's JWT session, for the routes the backend closes to API keys: `secrets/` (SecretViewSet →
 * DenyPersonalAndSystemApiKeys) and every recycle-bin purge (recycle_bin_mixins.purge_permissions →
 * DenyApiKeyAuth). Implemented by AuthService, which refreshes the session through the refresh
 * cookie instead of logging in again.
 */
export interface UserSession {
  /** A currently valid access token — refreshed or re-established as needed. */
  accessToken(): Promise<string>;
  /** The token was rejected (401): drop it and return a fresh one. */
  renewAccessToken(): Promise<string>;
  /** Whether a session can be opened at all (login credentials are configured). */
  hasUserSession(): boolean;
}

/** Run `call` with the session's bearer token; on a 401 renew the token once and retry. */
export async function withUserSession<T>(session: UserSession, call: (bearerToken: string) => Promise<T>): Promise<T> {
  try {
    return await call(await session.accessToken());
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return call(await session.renewAccessToken());
    }
    throw error;
  }
}

/**
 * Run a read with the session's bearer token when there is a session, else with the API key
 * (`bearerToken` undefined). EpicStaff narrows what a user API key sees to the key's organization
 * (profile memberships, cross-org admin lists); the session sees every organization of the user.
 */
export async function withUserSessionIfAvailable<T>(
  session: UserSession,
  call: (bearerToken: string | undefined) => Promise<T>,
): Promise<T> {
  return session.hasUserSession() ? withUserSession(session, call) : call(undefined);
}
