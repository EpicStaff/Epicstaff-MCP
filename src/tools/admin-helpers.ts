import { z } from 'zod';
import type { AdminOrganization, AdminOrganizationsApi } from '../api/admin-organizations.js';
import type { AdminRolesApi, RoleDto } from '../api/admin-roles.js';
import type { AdminUsersApi } from '../api/admin-users.js';
import { backendReason } from '../api/redaction.js';
import type { AppContext } from '../context.js';
import { ApiError } from '../http/errors.js';

/**
 * Building blocks of the administration tools (account, users, memberships, roles, API keys,
 * organizations, plugins, audit, first setup).
 *
 * Guard convention: every write on the admin surface, and every tool that mints or retires a
 * credential, takes `confirm: true` — the model may only pass it when the user explicitly asked for
 * that exact change. Reads and dry runs never need it.
 */

/** `confirm` for a write: required, and literally true. */
export function confirmFlag(action: string) {
  return z.literal(true).describe(`Must be true: the user explicitly asked to ${action}.`);
}

/** Refuse before calling when the change needs `confirm` and it is missing (dry runs pass). */
export function assertConfirmed(confirm: true | undefined, action: string): void {
  if (confirm !== true) {
    throw new Error(`Refusing to ${action} without confirm: true — pass it only when the user explicitly asked for this change.`);
  }
}

/**
 * Writes on the admin surface (RestrictApiKeyToUserKeyReads / DenyApiKeyAuth) and on the user's own
 * API keys are JWT-only on the backend: an API key may at most read. Fail before any request when the
 * server has no login to open a session with (EPICSTAFF_API_TOKEN-only configuration).
 */
export function requireSignedInSession(context: AppContext, operation: string): void {
  if (context.config.email === undefined || context.config.password === undefined) {
    throw new Error(
      `${operation} needs a signed-in EpicStaff session: EpicStaff accepts API keys only for reading the ` +
        'administration surface (a leaked key must not change who can do what, nor mint or retire keys). ' +
        'Set EPICSTAFF_USERNAME + EPICSTAFF_PASSWORD for the MCP server, or do this in the EpicStaff UI.',
    );
  }
}

export interface RefusalContext {
  /** What was attempted, as a verb phrase: "create the role". */
  action: string;
  /** What the backend requires, e.g. "superadmin rights" or "the `roles: create` permission in that organization". */
  requirement: string;
  /** What a 404 means for this call; defaults to the org-scoping explanation. */
  notFound?: string;
}

const ORG_SCOPED_NOT_FOUND =
  'not found — or it belongs to an organization you cannot administer (EpicStaff answers 404, never 403, for ' +
  'records outside your organizations)';

/**
 * Turn the admin surface's refusals into messages the model can act on: 403 names the missing right,
 * 404 explains org scoping, a domain refusal (400 without field errors, 409) carries the backend's
 * own `code: message`. Field-level validation errors pass through unchanged.
 */
export async function explainRefusals<T>(refusal: RefusalContext, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const reason = backendReason(error.bodyExcerpt);
    if (error.status === 403) {
      throw new Error(`EpicStaff refused to ${refusal.action} (HTTP 403${reason}). It needs ${refusal.requirement}.`);
    }
    if (error.status === 404) {
      throw new Error(`Could not ${refusal.action}: ${refusal.notFound ?? ORG_SCOPED_NOT_FOUND} (HTTP 404${reason}).`);
    }
    if ((error.status === 400 || error.status === 409) && !error.validationErrors?.length && reason) {
      throw new ApiError(error.status, error.url, `Could not ${refusal.action} (HTTP ${error.status}${reason}).`);
    }
    throw error;
  }
}

/** A reference to an account: numeric id or email. */
export const userRef = z.union([z.number().int().positive(), z.string().email()]);
/** A reference to an organization: numeric id or exact name. */
export const organizationRef = z.union([z.number().int().positive(), z.string().min(1)]);
/** A reference to a role: numeric id or exact name. */
export const roleRef = z.union([z.number().int().positive(), z.string().min(1)]);

const RESOLVE_PAGE_SIZE = 200;

/**
 * An organization id. Names are matched (case-insensitively) against the caller's memberships first —
 * a superadmin's profile lists every active organization — then the admin list, which also holds
 * deactivated organizations.
 */
export async function resolveOrganizationId(
  context: AppContext,
  organizations: AdminOrganizationsApi,
  ref: number | string,
): Promise<number> {
  if (typeof ref === 'number') return ref;
  const wanted = ref.trim().toLowerCase();
  const memberOf = (await context.org.resolve()).organizations.filter((org) => org.name.toLowerCase() === wanted);
  if (memberOf.length === 1 && memberOf[0]) return memberOf[0].id;
  if (memberOf.length > 1) throw ambiguous('Organization', ref, memberOf.map((org) => org.id));
  let listed: AdminOrganization[];
  try {
    listed = (await organizations.list({ search: ref.trim(), page_size: RESOLVE_PAGE_SIZE })).results;
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) listed = [];
    else throw error;
  }
  const matches = listed.filter((org) => org.name.toLowerCase() === wanted);
  if (matches.length > 1) throw ambiguous('Organization', ref, matches.map((org) => org.id));
  const match = matches[0];
  if (!match) {
    throw new Error(`Organization "${ref}" not found among the organizations you can see. Pass its numeric id (admin_list_organizations).`);
  }
  return match.id;
}

/** An account id; an email is looked up in admin/users (superadmin-only, like every caller of this). */
export async function resolveUserId(users: AdminUsersApi, ref: number | string): Promise<number> {
  if (typeof ref === 'number') return ref;
  const wanted = ref.trim().toLowerCase();
  const page = await users.list({ search: ref.trim(), page_size: RESOLVE_PAGE_SIZE });
  const match = page.results.find((user) => user.email.toLowerCase() === wanted);
  if (!match) throw new Error(`No account with the email "${ref}" (admin_list_users). Pass its numeric id instead.`);
  return match.id;
}

/**
 * A role id. With `orgId`, names are matched among the roles assignable there (the built-in templates
 * plus that organization's custom roles); without it, among every role the caller can read.
 */
export async function resolveRoleId(roles: AdminRolesApi, ref: number | string, orgId?: number): Promise<number> {
  if (typeof ref === 'number') return ref;
  const listed = await roles.list({
    ...(orgId !== undefined ? { assignable_org_ids: [orgId] } : {}),
    search: ref.trim(),
    page_size: RESOLVE_PAGE_SIZE,
  });
  const wanted = ref.trim().toLowerCase();
  const matches = [...listed.built_in_roles, ...listed.results].filter((role) => role.name.toLowerCase() === wanted);
  const unique = [...new Map(matches.map((role) => [role.id, role])).values()];
  if (unique.length > 1) throw ambiguous('Role', ref, unique.map((role) => role.id));
  const match = unique[0];
  if (!match) {
    const scope = orgId !== undefined ? ` assignable in organization ${orgId}` : '';
    throw new Error(`No role named "${ref}"${scope} (admin_list_roles). Pass its numeric id instead.`);
  }
  return match.id;
}

function ambiguous(kind: string, ref: string, ids: number[]): Error {
  return new Error(`${kind} "${ref}" is ambiguous — ids ${ids.join(', ')} carry that name. Pass the numeric id.`);
}

/** A role as tool output: who owns it and what it grants, without the per-org assignment breakdown. */
export function summarizeRole(role: RoleDto): Record<string, unknown> {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    built_in: role.is_built_in,
    organization: role.org ?? (role.scope === 'global' ? 'global' : null),
    assigned_count: role.assigned_count,
    permissions: Object.fromEntries(role.permissions.map((entry) => [entry.resource_type, entry.actions])),
  };
}

/** A page envelope as tool output. */
export function pageOf<T, R>(
  page: { count: number; next?: string | null; results: T[] },
  pageNumber: number,
  summarize: (item: T) => R,
): { count: number; page: number; has_more: boolean; items: R[] } {
  return { count: page.count, page: pageNumber, has_more: Boolean(page.next), items: page.results.map(summarize) };
}
