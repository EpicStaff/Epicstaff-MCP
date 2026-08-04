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
 * The plugin's .mcp.json passes every variable through `${VAR}` interpolation,
 * which turns unset variables into empty strings — treat those as absent.
 * Names are tried in order; the first non-empty value wins.
 */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value ? value : undefined;
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
    throw new Error(
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
