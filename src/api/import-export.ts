import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { ApiClient } from '../http/client.js';

/**
 * Import / export API — ported from core/services/import-export.service.ts (flows) and the
 * export/import methods of features/tools/services/{custom-tools/custom-tools,mcp-tools/mcp-tools}.service.ts,
 * with shared/models/export-result.model.ts and core/models/{import-result,review-item}.model.ts.
 *
 * Backend: ViewSetImportExportService (tables/services/import_export_service.py). An export is a
 * JSON document carrying the entity and everything it depends on (agents, LLM configs, tools …);
 * entities the caller may not export are left out and named in the `X-Export-Excluded` header.
 * Secret values are never exported.
 */
export type TransferKind = 'flow' | 'python_tool' | 'mcp_tool';

const TRANSFER_PATHS: Record<TransferKind, string> = {
  flow: 'graphs/',
  python_tool: 'python-code-tool/',
  mcp_tool: 'mcp-tools/',
};

export interface ExcludedExportEntity {
  type: string;
  count: number;
  names: string[];
}

export interface ExportResult {
  /** The export document exactly as the backend rendered it. */
  document: unknown;
  excluded: ExcludedExportEntity[];
}

/** Flow imports only (`ImportFlowRequestOptions`); tool imports take `importLabels` alone. */
export interface ImportOptions {
  /** Keep the file's uuids (required by `replaceExisting`). Flows only. */
  preserveUuids?: boolean;
  /** Overwrite flows with the same uuid in place instead of creating copies. Flows only. */
  replaceExisting?: boolean;
  /** Recreate the file's labels and tag the imported entities with them. */
  importLabels?: boolean;
}

export class ImportExportApi {
  constructor(private readonly client: ApiClient) {}

  /** One id → `GET <list>{id}/export/`; several → `POST <list>bulk-export/ {ids}`. */
  async export(kind: TransferKind, ids: number[]): Promise<ExportResult> {
    let excludedHeader: string | null = null;
    const onResponseHeaders = (headers: Headers): void => {
      excludedHeader = headers.get('X-Export-Excluded');
    };
    const path = TRANSFER_PATHS[kind];
    const document =
      ids.length === 1
        ? await this.client.get<unknown>(`${path}${ids[0]}/export/`, { onResponseHeaders })
        : await this.client.post<unknown>(`${path}bulk-export/`, { body: { ids }, onResponseHeaders });
    return { document, excluded: parseExcludedHeader(excludedHeader) };
  }

  /** Dry run: what importing the file would ask about (`import/inspect/`) — nothing is created. */
  async inspect(kind: TransferKind, filePath: string): Promise<unknown> {
    return this.client.post<unknown>(`${TRANSFER_PATHS[kind]}import/inspect/`, { formData: fileForm(filePath) });
  }

  async import(kind: TransferKind, filePath: string, options: ImportOptions): Promise<Record<string, unknown>> {
    const formData = fileForm(filePath);
    if (kind === 'flow') {
      formData.append('preserve_uuids', String(options.preserveUuids ?? false));
      formData.append('replace_existing', String(options.replaceExisting ?? false));
    }
    formData.append('import_labels', String(options.importLabels ?? true));
    return this.client.post<Record<string, unknown>>(`${TRANSFER_PATHS[kind]}import/`, { formData });
  }
}

function fileForm(filePath: string): FormData {
  const formData = new FormData();
  formData.append('file', new Blob([new Uint8Array(readFileSync(filePath))]), basename(filePath));
  return formData;
}

/** `parseExcludedHeader`: a JSON array of {type, count, names}; anything else reads as none. */
export function parseExcludedHeader(header: string | null): ExcludedExportEntity[] {
  if (!header) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.every(isExcludedExportEntity) ? parsed : [];
}

function isExcludedExportEntity(value: unknown): value is ExcludedExportEntity {
  if (typeof value !== 'object' || value === null) return false;
  const { type, count, names } = value as Record<string, unknown>;
  return (
    typeof type === 'string' &&
    typeof count === 'number' &&
    Array.isArray(names) &&
    names.every((name) => typeof name === 'string')
  );
}
