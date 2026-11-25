import { openSync, readFileSync, readSync, closeSync } from 'node:fs';
import { basename } from 'node:path';
import type { ApiClient } from '../http/client.js';

/**
 * Import / export API — ported from core/services/transfer-jobs.service.ts (background export and
 * import jobs) and core/services/import-export.service.ts plus the import methods of
 * features/tools/services/{custom-tools/custom-tools,mcp-tools/mcp-tools}.service.ts,
 * features/agent-definitions/services/agent-definitions-api.service.ts and
 * features/knowledge-sources/services/collections-api.service.ts (in-request import / inspect),
 * with core/models/{transfer-job,import-result,review-item}.model.ts.
 *
 * Backend: ExportJobActionMixin / InspectActionMixin (tables/views/mixins.py), TransferJobViewSet
 * (tables/views/transfer_job_views.py), the raw-body import upload
 * (tables/views/transfer_import_upload_view.py) and ViewSetImportExportService
 * (tables/services/import_export_service.py). An export is a `.zip` archive: `export.json` (the
 * entity and everything it depends on) plus the knowledge files it names. Dependencies the caller may
 * not export are left out and listed in the job's `result.excluded`. Secret values are never exported.
 */
export type TransferKind = 'flow' | 'python_tool' | 'mcp_tool' | 'agent_definition' | 'collection';

const TRANSFER_PATHS: Record<TransferKind, string> = {
  flow: 'graphs/',
  python_tool: 'python-code-tool/',
  mcp_tool: 'mcp-tools/',
  agent_definition: 'agent-definitions/',
  collection: 'source-collections/',
};

/** Kinds whose export body takes `include_knowledge` (KnowledgeExportJobCreateSerializer). */
const KNOWLEDGE_EXPORT_KINDS: ReadonlySet<TransferKind> = new Set(['flow', 'agent_definition']);
/** Kinds with an `import-jobs/` upload route (IMPORT_JOB_ROUTES); the others import within the request. */
const IMPORT_JOB_KINDS: ReadonlySet<TransferKind> = new Set(['flow', 'agent_definition', 'collection']);

/** The frontend's TRANSFER_JOB_POLL_INTERVAL_MS. */
const POLL_INTERVAL_MS = 2_000;
const ZIP_SIGNATURE = Buffer.from('PK\x03\x04', 'latin1');

/** One dependency an export job left out (`ExcludedExportItem`); `name` is null when the caller may not see it. */
export interface ExcludedExportItem {
  entity_type: string;
  entity_id: number;
  name: string | null;
}

/** `TransferJob` (core/models/transfer-job.model.ts), the fields MCP reads. */
export interface TransferJob {
  id: string;
  kind: 'export' | 'import';
  status: 'queued' | 'running' | 'completed' | 'failed';
  /** The archive's name once an export has finished. */
  file_name: string | null;
  /** Export: `{excluded}`; import: the import summary. Set once the job has completed. */
  result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
}

export interface ExportResult {
  /** The `.zip` archive exactly as the backend stored it. */
  archive: Uint8Array;
  fileName: string | null;
  excluded: ExcludedExportItem[];
}

/** Flow imports only (`ImportFlowRequestOptions`); tool and agent imports take `importLabels` alone. */
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

  /** `POST <list>export-jobs/` → wait for the job → `GET transfer-jobs/{id}/download/`. */
  async export(kind: TransferKind, ids: number[], includeKnowledge: boolean, waitMs: number): Promise<ExportResult> {
    const { job_id } = await this.client.post<{ job_id: string }>(`${TRANSFER_PATHS[kind]}export-jobs/`, {
      body: { ids, ...(KNOWLEDGE_EXPORT_KINDS.has(kind) ? { include_knowledge: includeKnowledge } : {}) },
    });
    const job = await this.waitForJob(job_id, waitMs);
    // shortcut: the archive is held in memory, stream it to disk if knowledge exports outgrow that.
    const archive = await this.client.get<Uint8Array>(`transfer-jobs/${job_id}/download/`, { binary: true });
    const excluded = job.result?.['excluded'];
    return { archive, fileName: job.file_name, excluded: Array.isArray(excluded) ? (excluded as ExcludedExportItem[]) : [] };
  }

  /** Dry run: what importing the file would ask about (`import/inspect/`, a `.json` or a `.zip`) — nothing is created. */
  async inspect(kind: TransferKind, filePath: string): Promise<unknown> {
    return this.client.post<unknown>(`${TRANSFER_PATHS[kind]}import/inspect/`, { formData: fileForm(filePath) });
  }

  /**
   * A `.zip` of a kind that has an import job is uploaded raw to `<list>import-jobs/` and waited for
   * (the in-request import refuses an archive carrying knowledge collections); anything else goes to
   * the in-request `<list>import/`, which takes a `.json` export or a `.zip` without collections.
   */
  async import(
    kind: TransferKind,
    filePath: string,
    options: ImportOptions,
    waitMs: number,
  ): Promise<Record<string, unknown> | null> {
    const path = TRANSFER_PATHS[kind];
    const importLabels = options.importLabels ?? true;
    if (IMPORT_JOB_KINDS.has(kind) && isZipFile(filePath)) {
      // The query serializers refuse a parameter their kind does not declare.
      const query = {
        // Cut by code point, as the server counts.
        file_name: Array.from(basename(filePath)).slice(0, 255).join(''),
        ...(kind === 'flow'
          ? { preserve_uuids: options.preserveUuids ?? false, replace_existing: options.replaceExisting ?? false }
          : {}),
        ...(kind === 'collection' ? {} : { import_labels: importLabels }),
      };
      const { job_id } = await this.client.post<{ job_id: string }>(`${path}import-jobs/`, {
        query,
        rawBody: new Blob([new Uint8Array(readFileSync(filePath))], { type: 'application/zip' }),
      });
      return (await this.waitForJob(job_id, waitMs)).result;
    }
    if (kind === 'collection') {
      throw new Error('A knowledge collection is imported from the .zip archive export_entities writes; this file is not a zip.');
    }
    const formData = fileForm(filePath);
    if (kind === 'flow') {
      formData.append('preserve_uuids', String(options.preserveUuids ?? false));
      formData.append('replace_existing', String(options.replaceExisting ?? false));
    }
    formData.append('import_labels', String(importLabels));
    return this.client.post<Record<string, unknown>>(`${path}import/`, { formData });
  }

  /** Poll `transfer-jobs/{id}/` until the job completes; a failed job or one still unfinished after `waitMs` throws. */
  private async waitForJob(jobId: string, waitMs: number): Promise<TransferJob> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const job = await this.client.get<TransferJob>(`transfer-jobs/${jobId}/`);
      if (job.status === 'completed') return job;
      if (job.status === 'failed') throw new Error(`The ${job.kind} failed: ${job.error?.message || 'no reason given.'}`);
      if (Date.now() + POLL_INTERVAL_MS > deadline) {
        throw new Error(
          `The ${job.kind} (job ${jobId}) is still ${job.status} on the server after ${Math.round(waitMs / 1000)}s. ` +
            (job.kind === 'import'
              ? 'It may still finish: check the list for the new items before importing the file again, so it is not imported twice.'
              : 'It may still finish: download it from "Exports and imports" in EpicStaff, or run the export again with a longer wait_seconds.'),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

function fileForm(filePath: string): FormData {
  const formData = new FormData();
  formData.append('file', new Blob([new Uint8Array(readFileSync(filePath))]), basename(filePath));
  return formData;
}

/** Told apart by the first bytes, not the name — the backend's `detect_file_kind`. */
function isZipFile(filePath: string): boolean {
  const head = Buffer.alloc(ZIP_SIGNATURE.length);
  const descriptor = openSync(filePath, 'r');
  try {
    readSync(descriptor, head, 0, head.length, 0);
  } finally {
    closeSync(descriptor);
  }
  return head.equals(ZIP_SIGNATURE);
}
