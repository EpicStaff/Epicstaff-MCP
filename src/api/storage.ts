import type { ApiClient } from '../http/client.js';
import { ApiError } from '../http/errors.js';

/**
 * Org storage lookup — minimal port of features/files/services/storage-api.service.ts
 * (`list`, `info`), used to resolve `{$storageFile: "<path>"}` template refs and the storage paths of a
 * knowledge import to storage_file ids.
 */
interface StorageItem {
  id?: number | null;
  name: string;
  path: string;
  type: 'file' | 'folder';
}

/** `GET storage/info/?path=` (`StorageItemInfo`): a file's or a folder's index row. */
interface StorageItemInfo {
  id: number | null;
  name: string;
  path: string;
}

export class StorageApi {
  constructor(private readonly client: ApiClient) {}

  /** Resolve an org-storage file path (e.g. "reports/summary.md") to its backend id. */
  async resolveFileId(filePath: string): Promise<number> {
    const normalized = filePath.replace(/^\/+/, '');
    const lastSlash = normalized.lastIndexOf('/');
    const directory = lastSlash === -1 ? '' : normalized.slice(0, lastSlash);
    const fileName = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);

    const listing = await this.client.get<{ path: string; items: StorageItem[] }>('storage/list/', {
      query: { path: directory },
    });
    const match = listing.items.find((item) => item.type === 'file' && item.name === fileName);
    if (!match || match.id == null) {
      const available = listing.items
        .filter((item) => item.type === 'file')
        .map((item) => item.name)
        .slice(0, 15)
        .join(', ');
      throw new Error(
        `Storage file "${filePath}" not found in org storage. Files in "${directory || '/'}": ${available || 'none'}.`,
      );
    }
    return match.id;
  }

  /**
   * Resolve an org-storage path of a file or a folder ("docs/", "docs/a.pdf") to its backend id
   * (StorageManager.info: the file row first, else the folder row).
   */
  async resolveItemId(itemPath: string): Promise<number> {
    const normalized = itemPath.replace(/^\/+/, '');
    if (normalized.replace(/\/+$/, '') === '') {
      throw new Error('The storage root has no id — name the folders or files to import instead.');
    }
    let info: StorageItemInfo;
    try {
      info = await this.client.get<StorageItemInfo>('storage/info/', { query: { path: normalized } });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        throw new Error(`Storage path "${itemPath}" not found in the active organization's storage.`);
      }
      throw error;
    }
    if (info.id == null) {
      throw new Error(`Storage path "${itemPath}" has no index row yet — pass its storage id instead.`);
    }
    return info.id;
  }
}
