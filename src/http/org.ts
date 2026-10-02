import type { StateStore } from '../state/store.js';
import { logger } from '../util/logger.js';
import type { EpicStaffClient } from './client.js';
import { ApiError } from './errors.js';

/**
 * Organization resolution — headless port of the frontend's
 * ProfileService.bootstrapUser() + ActiveOrgService:
 * orgs come from GET /api/profile/ memberships[]; the chosen org id is persisted
 * and attached to every request as X-Organization-Id by the client.
 *
 * Multi-org policy (confirmed): auto-select when exactly one active org;
 * with several, require an explicit set_active_organization — no silent default.
 */
export interface Organization {
  id: number;
  name: string;
  isActive: boolean;
}

export interface OrgStatus {
  organizations: Organization[];
  activeOrgId: number | null;
  /** True when a pick is required before entity-creating calls can proceed. */
  selectionRequired: boolean;
}

interface ProfileResponse {
  memberships?: Array<{
    organization?: { id?: number; name?: string; is_active?: boolean };
  }>;
  active_organization_id?: number | null;
}

export class OrgService {
  /** Set once the persisted selection was validated against the profile in this process. */
  private resolved = false;
  private resolvePromise: Promise<void> | null = null;

  constructor(
    private readonly store: StateStore,
    private readonly client: EpicStaffClient,
  ) {
    client.onOrgContextNeeded(() => this.ensureResolved());
  }

  /**
   * Resolve the active org once per process, before the first org-scoped request: validates the
   * persisted selection against the profile memberships and auto-selects a single org — the
   * same as check_connection — so a fresh server process never sends org-scoped calls without
   * X-Organization-Id. Single-flight; a failed lookup is retried on the next request.
   */
  async ensureResolved(): Promise<void> {
    if (this.resolved) return;
    this.resolvePromise ??= this.resolve()
      .then(() => undefined)
      .catch((error: unknown) => {
        // A backend without profile/ (pre-RBAC) has no org context to resolve.
        if (error instanceof ApiError && error.status === 404) {
          logger.info('profile/ not found — this backend has no organizations; sending no org header');
          this.resolved = true;
          return;
        }
        throw error;
      })
      .finally(() => {
        this.resolvePromise = null;
      });
    return this.resolvePromise;
  }

  async resolve(): Promise<OrgStatus> {
    const profile = await this.client.get<ProfileResponse>('profile/');
    const organizations: Organization[] = (profile.memberships ?? [])
      .map((membership) => membership.organization)
      .filter((org): org is NonNullable<typeof org> => org?.id !== undefined)
      .map((org) => ({
        id: org.id as number,
        name: org.name ?? `organization ${org.id}`,
        isActive: org.is_active ?? true,
      }))
      .filter((org) => org.isActive);

    let { activeOrgId } = this.store.get();

    // Drop a persisted selection that no longer matches a membership.
    if (activeOrgId !== null && !organizations.some((org) => org.id === activeOrgId)) {
      logger.warn(`Persisted active org ${activeOrgId} is not among current memberships — clearing`);
      activeOrgId = null;
      this.store.update({ activeOrgId: null });
    }

    // Auto-select only when the choice is unambiguous.
    if (activeOrgId === null && organizations.length === 1) {
      activeOrgId = organizations[0]!.id;
      this.store.update({ activeOrgId });
      logger.info(`Auto-selected the only organization: ${organizations[0]!.name} (${activeOrgId})`);
    }

    this.resolved = true;
    return {
      organizations,
      activeOrgId,
      selectionRequired: activeOrgId === null && organizations.length > 1,
    };
  }

  async setActive(orgId: number): Promise<OrgStatus> {
    const status = await this.resolve();
    const match = status.organizations.find((org) => org.id === orgId);
    if (!match) {
      const available = status.organizations.map((org) => `${org.id} (${org.name})`).join(', ');
      throw new Error(`Organization ${orgId} is not among your memberships. Available: ${available || 'none'}.`);
    }
    this.store.update({ activeOrgId: orgId });
    return { ...status, activeOrgId: orgId, selectionRequired: false };
  }

  /**
   * The active org id for entity-creating calls. Resolves lazily first (see ensureResolved), so a
   * fresh process with a saved selection — or a single membership — never needs check_connection.
   */
  async requireActiveOrg(): Promise<number> {
    await this.ensureResolved();
    const { activeOrgId } = this.store.get();
    if (activeOrgId === null) {
      throw new Error(
        'No active organization selected. Call list_organizations, then set_active_organization first.',
      );
    }
    return activeOrgId;
  }
}
