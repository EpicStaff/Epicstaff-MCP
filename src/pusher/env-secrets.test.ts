import { afterEach, describe, expect, it } from 'vitest';
import type { Secret, SecretsApi } from '../api/secrets.js';
import { ensureSecretFromEnv } from './env-secrets.js';

const ENV_NAME = 'ENV_SECRETS_TEST_KEY';
const CURRENT_VALUE = 'sk-rotated-value-0000-wxyz';
const STORED_TAIL = 'abcd';

/** A SecretsApi double holding one secret named `es-mcp:<ENV_NAME>` whose stored value ended in STORED_TAIL. */
function secretsWith(existing: Secret | undefined): { api: SecretsApi; created: Array<{ name: string; value: string }> } {
  const created: Array<{ name: string; value: string }> = [];
  const api = {
    findByName: async (name: string) => (existing?.name === name ? existing : undefined),
    create: async (name: string, value: string) => {
      created.push({ name, value });
      return { id: 99, name, tail: value.slice(-4) };
    },
  } as unknown as SecretsApi;
  return { api, created };
}

describe('ensureSecretFromEnv', () => {
  afterEach(() => {
    delete process.env[ENV_NAME];
  });

  it('refuses a rotated value without putting any part of either value in the message', async () => {
    process.env[ENV_NAME] = CURRENT_VALUE;
    const { api, created } = secretsWith({ id: 5, name: `es-mcp:${ENV_NAME}`, tail: STORED_TAIL });

    const failure = await ensureSecretFromEnv(api, `es-mcp:${ENV_NAME}`, ENV_NAME).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toMatch(/already exists but holds a different value than ENV_SECRETS_TEST_KEY\. /);
    expect(failure?.message).not.toContain(STORED_TAIL);
    expect(failure?.message).not.toContain(CURRENT_VALUE.slice(-4));
    expect(failure?.message).not.toMatch(/tail/i);
    expect(created).toHaveLength(0);
  });

  it('reuses an existing secret whose tail matches the current value', async () => {
    process.env[ENV_NAME] = CURRENT_VALUE;
    const { api, created } = secretsWith({ id: 5, name: `es-mcp:${ENV_NAME}`, tail: CURRENT_VALUE.slice(-4) });

    expect(await ensureSecretFromEnv(api, `es-mcp:${ENV_NAME}`, ENV_NAME)).toEqual({ backendId: 5, created: false });
    expect(created).toHaveLength(0);
  });
});
