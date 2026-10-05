import { z } from 'zod';

/**
 * Environment contract (matches the original epicstaff-mcp plugin):
 *
 *   EPICSTAFF_BASE_URL   — EpicStaff server URL (required)
 *   EPICSTAFF_API_TOKEN  — pre-issued API key; used directly, no login
 *   EPICSTAFF_USERNAME   — login email; the server mints an API key
 *   EPICSTAFF_PASSWORD   — login password
 *
 * Either the token or the username+password pair must be set (token wins
 * when both are).
 */
export interface Config {
  /** Base API URL, always ending in `/api/` (matches the frontend ConfigService.apiUrl convention). */
  apiUrl: string;
  email?: string;
  password?: string;
  /** Pre-issued API key (EPICSTAFF_API_TOKEN) — skips the login/mint flow. */
  apiToken?: string;
}

const urlSchema = z
  .string()
  .url('EPICSTAFF_BASE_URL must be a valid URL, e.g. http://127.0.0.1')
  .transform(normalizeApiUrl);

const emailSchema = z.string().email('EPICSTAFF_USERNAME must be a valid email address');

/**
 * Normalize any user-supplied EpicStaff URL to the frontend convention:
 * a base URL ending in `/api/`, so callers concatenate `resource/` directly.
 * Accepts `http://host`, `http://host/`, `http://host/api`, `http://host/api/`.
 */
function normalizeApiUrl(raw: string): string {
  let url = raw.replace(/\/+$/, '');
  if (!url.endsWith('/api')) {
    url = `${url}/api`;
  }
  return `${url}/`;
}

/**
 * Raised when the MCP server environment is missing or malformed. The server still starts
 * (see index.ts) and every tool that needs the backend returns this message, so the user sees
 * what to fix instead of Claude Code's bare "Connection closed".
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * A literal, unexpanded `${VAR}` / `${VAR:-default}` placeholder. Claude Code passes the
 * placeholder through verbatim when the variable is unset in the user's shell, so the server
 * would otherwise try to log in as the user "${EPICSTAFF_USERNAME}".
 */
const UNEXPANDED_PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_]*(:?[-=+?][^}]*)?\}$/;

/**
 * Read one environment variable, treating every "not really set" form as absent: undefined,
 * an empty or whitespace-only string (the plugin's .mcp.json `${VAR}` interpolation turns unset
 * variables into empty strings) and an unexpanded `${VAR}` placeholder.
 */
export function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || UNEXPANDED_PLACEHOLDER.test(trimmed)) return undefined;
  return value;
}

/**
 * Environment variables a flow source may NOT name as a credential source (`api_key_env`,
 * `bot_token_env`): the MCP server's own login and state settings. Without this, a flow could
 * copy `EPICSTAFF_PASSWORD` into an org secret readable by every flow in the organization.
 */
// Case-insensitive: on Windows process.env lookups ignore case, so `epicstaff_password` reads
// EPICSTAFF_PASSWORD.
export const RESERVED_ENV_NAME = /^(EPICSTAFF_|ES_MCP_)/i;

export function isReservedEnvName(name: string): boolean {
  return RESERVED_ENV_NAME.test(name);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const baseUrl = readEnv(env, 'EPICSTAFF_BASE_URL');
  const email = readEnv(env, 'EPICSTAFF_USERNAME');
  const password = readEnv(env, 'EPICSTAFF_PASSWORD');
  const apiToken = readEnv(env, 'EPICSTAFF_API_TOKEN');

  const problems: string[] = [];

  let apiUrl: string | undefined;
  if (baseUrl === undefined) {
    problems.push('EPICSTAFF_BASE_URL is not set');
  } else {
    const parsedUrl = urlSchema.safeParse(baseUrl);
    if (parsedUrl.success) {
      apiUrl = parsedUrl.data;
    } else {
      problems.push(parsedUrl.error.issues[0]?.message ?? 'EPICSTAFF_BASE_URL is invalid');
    }
  }

  if (apiToken === undefined) {
    if (email === undefined && password === undefined) {
      problems.push(
        'set EPICSTAFF_API_TOKEN, or EPICSTAFF_USERNAME + EPICSTAFF_PASSWORD to log in and mint a key',
      );
    } else if (email === undefined) {
      problems.push('EPICSTAFF_USERNAME is not set (required with EPICSTAFF_PASSWORD)');
    } else if (password === undefined) {
      problems.push('EPICSTAFF_PASSWORD is not set (required with EPICSTAFF_USERNAME)');
    }
  }

  if (email !== undefined) {
    const parsedEmail = emailSchema.safeParse(email);
    if (!parsedEmail.success) {
      problems.push(parsedEmail.error.issues[0]?.message ?? 'EPICSTAFF_USERNAME is invalid');
    }
  }

  if (problems.length > 0 || apiUrl === undefined) {
    throw new ConfigurationError(
      `Invalid EpicStaff MCP configuration — ${problems.join('; ')}. ` +
        'Set EPICSTAFF_BASE_URL plus either EPICSTAFF_API_TOKEN or ' +
        'EPICSTAFF_USERNAME + EPICSTAFF_PASSWORD in the MCP server environment.',
    );
  }

  return {
    apiUrl,
    ...(email !== undefined ? { email } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(apiToken !== undefined ? { apiToken } : {}),
  };
}
