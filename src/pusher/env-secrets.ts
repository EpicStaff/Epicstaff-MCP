import { secretTail, type SecretsApi } from '../api/secrets.js';
import { isReservedEnvName, readEnv } from '../config.js';
import { logger } from '../util/logger.js';

/**
 * Credentials reach EpicStaff only as org Secrets created from an environment variable of the MCP
 * server — never as a value in flow source, a tool argument, a log line or a tool result. Shared by
 * the flow pusher (`api_key_env`, `bot_token_env`) and the config tools (create_secret,
 * create_llm_config, run_quickstart …).
 */

/** Read a credential from the server environment; the MCP server's own settings are refused. */
export function readCredentialEnv(envName: string): string {
  // Defense in depth — the flow-source schema and the tool schemas already reject these names.
  if (isReservedEnvName(envName)) {
    throw new Error(
      `Environment variable "${envName}" belongs to the MCP server's own configuration and cannot be stored ` +
        'as a credential. Export the provider key under its own name and reference that instead.',
    );
  }
  const resolved = readEnv(process.env, envName);
  if (resolved === undefined) {
    throw new Error(
      `Environment variable "${envName}" is not set for the MCP server. ` +
        'Export it in the shell that launches Claude Code (or the plugin env), then restart it.',
    );
  }
  return resolved;
}

/**
 * Store the value of environment variable `envName` as the org Secret `name`, or reuse that
 * secret. Secrets are immutable, so an existing one is reused only when its visible tail matches
 * the current value; a mismatch means the value was rotated and the user must delete the old
 * secret (it may still be referenced elsewhere). The value is never logged or returned.
 */
export async function ensureSecretFromEnv(
  secrets: SecretsApi,
  name: string,
  envName: string,
): Promise<{ backendId: number; created: boolean }> {
  const value = readCredentialEnv(envName);
  const existing = await secrets.findByName(name);
  if (existing) {
    if (existing.tail !== secretTail(value)) {
      // No part of either value goes into the message: it reaches the MCP client through every tool
      // that takes a credential env var.
      throw new Error(
        `Org secret "${name}" already exists but holds a different value than ${envName}. EpicStaff secrets ` +
          `are immutable — delete "${name}" (delete_secret) and try again, or restore the previous value of ${envName}.`,
      );
    }
    return { backendId: existing.id, created: false };
  }
  logger.info(`Creating org secret "${name}" from ${envName}`);
  return { backendId: (await secrets.create(name, value)).id, created: true };
}
