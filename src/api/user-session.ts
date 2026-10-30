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
