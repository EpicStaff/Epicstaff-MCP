import { logger } from '../util/logger.js';
export class OrgService {
    store;
    client;
    constructor(store, client) {
        this.store = store;
        this.client = client;
    }
    async resolve() {
        const profile = await this.client.get('profile/');
        const organizations = (profile.memberships ?? [])
            .map((membership) => membership.organization)
            .filter((org) => org?.id !== undefined)
            .map((org) => ({
            id: org.id,
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
            activeOrgId = organizations[0].id;
            this.store.update({ activeOrgId });
            logger.info(`Auto-selected the only organization: ${organizations[0].name} (${activeOrgId})`);
        }
        return {
            organizations,
            activeOrgId,
            selectionRequired: activeOrgId === null && organizations.length > 1,
        };
    }
    async setActive(orgId) {
        const status = await this.resolve();
        const match = status.organizations.find((org) => org.id === orgId);
        if (!match) {
            const available = status.organizations.map((org) => `${org.id} (${org.name})`).join(', ');
            throw new Error(`Organization ${orgId} is not among your memberships. Available: ${available || 'none'}.`);
        }
        this.store.update({ activeOrgId: orgId });
        return { ...status, activeOrgId: orgId, selectionRequired: false };
    }
    requireActiveOrg() {
        const { activeOrgId } = this.store.get();
        if (activeOrgId === null) {
            throw new Error('No active organization selected. Call list_organizations, then set_active_organization first.');
        }
        return activeOrgId;
    }
}
