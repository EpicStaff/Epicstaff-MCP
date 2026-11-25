/**
 * Storage grants (EpicStaff 1.6+) — ported from `visual-programming/core/models/storage-grants.model.ts`
 * and `core/helpers/storage-grants.util.ts`. They replace the per-node `use_storage` switch.
 */

/** What one slot of a node's code may do with the flow's attached files, per kind of access. */
export interface StorageGrants {
  read: boolean;
  write: boolean;
  delete: boolean;
}

/** The grant columns of a node DTO that has one slot of code (python node, webhook trigger). */
export interface StorageGrantFields {
  storage_grant_read?: boolean;
  storage_grant_write?: boolean;
  storage_grant_delete?: boolean;
}

/** The grant columns of a classification decision table, which has a pre-code and a post-code slot. */
export interface CdtStorageGrantFields {
  pre_storage_grant_read?: boolean;
  pre_storage_grant_write?: boolean;
  pre_storage_grant_delete?: boolean;
  post_storage_grant_read?: boolean;
  post_storage_grant_write?: boolean;
  post_storage_grant_delete?: boolean;
}

type GrantPrefix = '' | 'pre_' | 'post_';

/** The grants of one slot as the server sent them; `undefined` when it sent none of the three columns. */
export function storageGrantsFromDto(
  dto: StorageGrantFields | CdtStorageGrantFields,
  prefix: GrantPrefix = '',
): StorageGrants | undefined {
  const columns = dto as Record<string, boolean | undefined>;
  const read = columns[`${prefix}storage_grant_read`];
  const write = columns[`${prefix}storage_grant_write`];
  const remove = columns[`${prefix}storage_grant_delete`];
  if (read === undefined && write === undefined && remove === undefined) return undefined;
  return { read: read === true, write: write === true, delete: remove === true };
}

/**
 * The three columns of one slot for a save. Divergence from the frontend, which leaves them out when
 * the node holds none: a node without grants is one flow source created, and it starts with no access
 * (the frontend's `newNodeStorageGrants`), so all three go out as false.
 */
export function storageGrantsToPayload<P extends GrantPrefix = ''>(
  grants: StorageGrants | undefined,
  prefix: P = '' as P,
): Record<`${P}storage_grant_${'read' | 'write' | 'delete'}`, boolean> {
  return {
    [`${prefix}storage_grant_read`]: grants?.read ?? false,
    [`${prefix}storage_grant_write`]: grants?.write ?? false,
    [`${prefix}storage_grant_delete`]: grants?.delete ?? false,
  } as Record<`${P}storage_grant_${'read' | 'write' | 'delete'}`, boolean>;
}
