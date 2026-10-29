/**
 * Read-only authorship of a resource. Ported from frontend `shared/models/authorship.model.ts`
 * + `visual-programming/core/models/numbered-node-dto.model.ts`.
 */

/** Public identity of a user as the backend renders an author or last editor (`UserSummarySerializer`). */
export interface UserSummary {
  id: number;
  /** Null when the user never set a display name; there is no email fallback. */
  display_name: string | null;
  /** Absolute URL of the user's avatar; null when none is set. */
  avatar_url: string | null;
}

/**
 * How MCP output names a person: the display name, else the user id. Like the frontend, there is
 * no email fallback — the backend does not send one.
 */
export function describeUser(user: UserSummary | null | undefined): string | null {
  if (user == null) return null;
  return user.display_name ?? `user #${user.id}`;
}

/** Last edit of a resource whose edits the backend tracks. Both null until an edit is recorded. */
export interface LastEditFields {
  last_edited_by: UserSummary | null;
  /** ISO 8601 timestamp of the last edit. */
  last_edited_at: string | null;
}

/** Author of a resource. Null when the author is unknown or has left the organization. */
export interface AuthorFields {
  created_by: UserSummary | null;
}

/** Read-only author and last edit of an authored resource. */
export interface AuthorshipFields extends AuthorFields, LastEditFields {}

/**
 * A node the backend numbers within its graph (every type except Start, End and Note). The number
 * is issued by the graph's counter, read-only for the client, and null only on rows the backend has
 * not numbered.
 */
export interface NumberedNodeDto {
  node_number: number | null;
}
