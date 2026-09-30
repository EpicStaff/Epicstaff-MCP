export class StorageApi {
    client;
    constructor(client) {
        this.client = client;
    }
    /** Resolve an org-storage file path (e.g. "reports/summary.md") to its backend id. */
    async resolveFileId(filePath) {
        const normalized = filePath.replace(/^\/+/, '');
        const lastSlash = normalized.lastIndexOf('/');
        const directory = lastSlash === -1 ? '' : normalized.slice(0, lastSlash);
        const fileName = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
        const listing = await this.client.get('storage/list/', {
            query: { path: directory },
        });
        const match = listing.items.find((item) => item.type === 'file' && item.name === fileName);
        if (!match || match.id == null) {
            const available = listing.items
                .filter((item) => item.type === 'file')
                .map((item) => item.name)
                .slice(0, 15)
                .join(', ');
            throw new Error(`Storage file "${filePath}" not found in org storage. Files in "${directory || '/'}": ${available || 'none'}.`);
        }
        return match.id;
    }
}
