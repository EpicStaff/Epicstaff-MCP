import { z } from 'zod';
import type { SecretsApi } from '../api/secrets.js';
import { secretName } from '../compiler/template-refs.js';
import { ApiError } from '../http/errors.js';
import { type AuthorshipFields, describeUser } from '../models/authorship.js';
import { ensureSecretFromEnv } from '../pusher/env-secrets.js';

/**
 * Building blocks shared by the catalog/config tool modules: id-or-name references, the
 * org-unique-name conflict on create, credential inputs and authored-entity summaries.
 */

/** A reference: a backend id (number) or the exact name (string) of an existing entity. */
export const idOrName = z.union([z.number().int(), z.string().min(1)]);

/**
 * Resolve an id-or-name reference to a backend id. Numbers pass through; a name is matched
 * case-insensitively against `list()`, the same lookup the flow pusher uses.
 */
export async function resolveNamedRef<T>(
  ref: number | string,
  entityLabel: string,
  list: () => Promise<T[]>,
  idOf: (item: T) => number | undefined,
  nameOf: (item: T) => string,
): Promise<number> {
  if (typeof ref === 'number') return ref;
  const items = await list();
  const wanted = ref.trim().toLowerCase();
  const matches = items.filter((item) => nameOf(item).toLowerCase() === wanted);
  if (matches.length > 1) {
    const ids = matches.map(idOf).filter((id): id is number => id !== undefined);
    throw new Error(
      `${entityLabel} "${ref}" is ambiguous — ${matches.length} entries carry that name (ids ${ids.join(', ')}). ` +
        'Pass the numeric backend id instead.',
    );
  }
  const match = matches[0];
  const id = match ? idOf(match) : undefined;
  if (id === undefined) {
    const available = items.map(nameOf).filter(Boolean).slice(0, 30).join(', ');
    throw new Error(
      `${entityLabel} "${ref}" not found in the active organization. Available: ${available || '(none)'}. ` +
        'Pass a numeric backend id or an exact existing name.',
    );
  }
  return id;
}

/**
 * Detect a "name already exists" failure. Agents return 409
 * (agent_definition_conflict); most other resources surface a 400 whose body carries the
 * Django uniqueness message. Neither uses the structured errors[] array.
 */
export function isAlreadyExistsError(error: ApiError): boolean {
  if (error.status === 409) return true;
  const haystack = [
    error.message,
    error.bodyExcerpt ?? '',
    ...(error.validationErrors?.map((issue) => `${issue.field} ${issue.reason}`) ?? []),
  ]
    .join(' ')
    .toLowerCase();
  return /already exist|must be unique|unique constraint|duplicate|conflict/.test(haystack);
}

export async function createOrExplainConflict<T>(
  create: () => Promise<T>,
  name: string,
  updateToolName: string,
): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (error instanceof ApiError && isAlreadyExistsError(error)) {
      throw new Error(
        `An entity named "${name}" already exists in this organization (catalog names are org-unique). ` +
          `Use ${updateToolName} to modify the existing one, or choose a different name.`,
      );
    }
    throw error;
  }
}

/**
 * The org Secret id for a credential input pair — an environment variable of the MCP server
 * (`*_env`, stored as the org Secret `es-mcp:<ENV>`, reused while it holds the same value) or an
 * existing org Secret by id or name (`*_secret`). undefined = leave the credential as it is,
 * null = clear it. The value itself is never returned or logged.
 */
export async function resolveCredential(
  secrets: () => SecretsApi,
  credentialEnv: string | undefined,
  credentialSecret: number | string | null | undefined,
  inputNames: { env: string; secret: string } = { env: 'api_key_env', secret: 'api_key_secret' },
): Promise<number | null | undefined> {
  if (credentialEnv !== undefined && credentialSecret !== undefined) {
    throw new Error(`Pass either ${inputNames.env} or ${inputNames.secret}, not both.`);
  }
  if (credentialEnv !== undefined) {
    return (await ensureSecretFromEnv(secrets(), secretName(credentialEnv), credentialEnv)).backendId;
  }
  if (credentialSecret === null || credentialSecret === undefined) return credentialSecret;
  const api = secrets();
  return resolveNamedRef(credentialSecret, 'Secret', () => api.list(), (secret) => secret.id, (secret) => secret.name);
}

/** An authored entity as tool output: authors named like the editor does. Only secret ids ever appear, never a value. */
export function summarizeAuthored<T extends Partial<AuthorshipFields>>(entity: T): Record<string, unknown> {
  const { created_by, last_edited_by, ...rest } = entity;
  return {
    ...rest,
    ...(created_by !== undefined ? { created_by: describeUser(created_by) } : {}),
    ...(last_edited_by !== undefined ? { last_edited_by: describeUser(last_edited_by) } : {}),
  };
}

/** Keep only the fields the caller set (undefined = untouched; null = cleared). */
export function pickDefined<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** The pointer every delete result carries: binned items come back with restore_from_recycle_bin. */
export function recycleBinHint(kind: string, id: number): string {
  return (
    `It is in the recycle bin: list_recycle_bin(kind: "${kind}") shows it, ` +
    `restore_from_recycle_bin(kind: "${kind}", ids: [${id}]) brings it back.`
  );
}
