import type { AppContext } from '../context.js';
import type { BuildArtifact, EntityPlan } from '../compiler/artifact.js';
import { ragRefKey, substituteRefs } from '../compiler/artifact.js';
import { isBuiltinToolRef, isEnvRef, isModelRef, isStorageFileRef } from '../compiler/template-refs.js';
import { StorageApi } from '../api/storage.js';
import { AgentDefinitionsApi } from '../api/agent-definitions.js';
import { KnowledgeApi } from '../api/knowledge.js';
import { LlmApi, resolveDefaultEmbeddingConfigId } from '../api/llm.js';
import { SecretsApi, secretTail } from '../api/secrets.js';
import { SurfacesApi } from '../api/surfaces.js';
import { ToolsApi } from '../api/tools.js';
import {
  type FlowLock,
  contentHash,
  getDocument,
  getEntity,
  isEntityDirty,
  removeEntity,
  setDocument,
  setEntity,
} from '../flow-source/lockfile.js';
import { logger } from '../util/logger.js';
import { readFileSync } from 'node:fs';
import { isReservedEnvName, readEnv } from '../config.js';
import { ApiError } from '../http/errors.js';

/**
 * Entity pusher — materializes the dependency tree of a BuildArtifact in order
 * (secrets → llm-configs → tools → knowledge → surfaces →
 * agent-definitions), following the reuse-first policy:
 *   lockfile hit + clean hash → reuse id;
 *   lockfile hit + dirty hash → update in place;
 *   `existing:` reference     → resolve by remote name, never modify;
 *   `ensure` plan             → find by name on every push, create when missing
 *                               (never lock-cached);
 *   otherwise                 → create.
 */
export interface EntityPushAction {
  key: string;
  kind: string;
  action: 'created' | 'updated' | 'reused' | 'resolved-existing';
  backendId: number;
}

export interface EntityPushResult {
  idMap: Map<string, number>;
  lock: FlowLock;
  actions: EntityPushAction[];
  /** Stale lock entries dropped / entities adopted — push_flow relays them to the user. */
  warnings: string[];
}


export class EntityPusher {
  private readonly llm;
  private readonly tools;
  private readonly knowledge;
  private readonly surfaces;
  private readonly agentDefinitions;
  private readonly storage;
  private readonly secrets;
  private modelIdByName: Map<string, number> | null = null;
  private builtinToolIdByName: Map<string, number> | null = null;

  constructor(private readonly context: AppContext) {
    this.llm = new LlmApi(context.client);
    this.tools = new ToolsApi(context.client);
    this.knowledge = new KnowledgeApi(context.client);
    this.surfaces = new SurfacesApi(context.client);
    this.agentDefinitions = new AgentDefinitionsApi(context.client);
    this.storage = new StorageApi(context.client);
    this.secrets = new SecretsApi(context.client, context.auth);
  }

  /**
   * @param options.sections When set, only entity plans whose `section` is in
   * this list are pushed — the rest are skipped entirely. Used by
   * provision_knowledge to materialize just `llm_configs` + `knowledge` ahead of
   * the full flow. Omitting `options` pushes everything (the default push_flow
   * behavior, unchanged).
   * @param options.verifyLockedIds Re-check every locked id against the backend before trusting
   * it (the id must exist AND carry the entity's name); a stale id is dropped and the entity
   * created anew. Set by push_flow when the lockfile's graph turned out to be gone — a sign the
   * lockfile is stale or from another instance, where a reused id could point at an unrelated entity.
   */
  async push(
    artifact: BuildArtifact,
    lock: FlowLock,
    options?: {
      sections?: string[];
      verifyLockedIds?: boolean;
      /**
       * Persist the lock after every entity, so a failure later in the walk does not orphan the
       * entities already created (their ids would be lost and the retry would collide on the
       * backend's unique names). Supplied by push_flow / provision_knowledge.
       */
      persistLock?: (lock: FlowLock) => Promise<void>;
      /**
       * An entity with no lock entry adopts (and updates) a same-named backend entity instead of
       * failing on the backend's unique name. NEVER set by push_flow — adopting could overwrite an
       * entity another flow owns; used only by the live test harnesses, whose lockfiles are local state.
       */
      adoptByName?: boolean;
    },
  ): Promise<EntityPushResult> {
    const idMap = new Map<string, number>();
    const actions: EntityPushAction[] = [];
    const warnings: string[] = [];
    let currentLock = lock;

    for (const plan of artifact.entities) {
      if (options?.sections && !options.sections.includes(plan.section)) {
        continue;
      }

      if (plan.action === 'resolve-existing') {
        const backendId = await this.resolveExisting(plan);
        idMap.set(plan.key, backendId);
        actions.push({ key: plan.key, kind: plan.kind, action: 'resolved-existing', backendId });
        continue;
      }

      if (plan.action === 'ensure') {
        const { backendId, created } = await this.ensureEntity(plan);
        idMap.set(plan.key, backendId);
        actions.push({ key: plan.key, kind: plan.kind, action: created ? 'created' : 'reused', backendId });
        continue;
      }

      const resolvedPayload = await this.resolvePayload(plan.payload ?? {}, idMap, plan.key);
      const hash = plan.contentHash ?? contentHash(plan.payload ?? {});
      let lockEntry = getEntity(currentLock, plan.section, plan.name);
      let adoptedId: number | undefined;

      if (lockEntry && options?.verifyLockedIds === true && !(await this.isLockedIdValid(plan, lockEntry.backendId))) {
        // A stale id (deleted, or a foreign lockfile) is dropped — never re-pointed at a same-named
        // entity: names are not namespaced per flow, so that entity may be shared by other flows.
        // The entity is created fresh; a unique-name conflict surfaces as an actionable error.
        warnings.push(
          `${plan.key}: locked id #${lockEntry.backendId} no longer exists under "${expectedRemoteName(plan)}" in this ` +
            'organization — dropped from flow.lock.json and created anew.',
        );
        logger.warn(`Locked id #${lockEntry.backendId} of ${plan.key} is stale — dropping it`);
        currentLock = removeEntity(currentLock, plan.section, plan.name);
        currentLock = removeEntity(currentLock, plan.section, `${plan.name}#rag`);
        lockEntry = undefined;
      }
      if (lockEntry === undefined && options?.adoptByName === true) {
        // Live test harnesses only (their lockfiles are local state): reuse a same-named entity.
        adoptedId = await this.lookupByName(plan, expectedRemoteName(plan));
        if (adoptedId !== undefined) {
          warnings.push(`${plan.key}: adopted the existing same-named entity #${adoptedId} and updated it.`);
        }
      }

      let backendId: number;
      let action: EntityPushAction['action'];
      if (adoptedId !== undefined) {
        backendId = await this.updateEntity(plan, adoptedId, resolvedPayload);
        action = 'updated';
      } else if (lockEntry && !isEntityDirty(currentLock, plan.section, plan.name, hash)) {
        backendId = lockEntry.backendId;
        action = 'reused';
      } else if (lockEntry) {
        backendId = await this.updateEntity(plan, lockEntry.backendId, resolvedPayload);
        action = 'updated';
      } else {
        backendId = await this.createEntity(plan, resolvedPayload);
        action = 'created';
      }

      currentLock = setEntity(currentLock, plan.section, plan.name, { backendId, contentHash: hash });
      idMap.set(plan.key, backendId);
      actions.push({ key: plan.key, kind: plan.kind, action, backendId });
      if (action !== 'reused') await options?.persistLock?.(currentLock);

      if (plan.kind === 'knowledge_collection') {
        currentLock = await this.pushCollectionExtras(plan, backendId, idMap, currentLock);
        // knowledge-retriever nodes address the collection's RAG impl id (see ragRefKey).
        const ragEntry = plan.rag ? getEntity(currentLock, plan.section, `${plan.name}#rag`) : undefined;
        if (plan.rag && ragEntry) {
          idMap.set(ragRefKey(plan.key, plan.rag.strategy), ragEntry.backendId);
        }
      }
    }

    return { idMap, lock: currentLock, actions, warnings };
  }

  /**
   * Substitute the placeholder kinds an upsert payload may carry:
   * `{$ref}` (entity pushed earlier in this walk), `{$model}` (LLM model by name),
   * `{$tool}` (built-in catalog tool by name), `{$storageFile}` (org storage path).
   *
   * `{$env}` is deliberately NOT substituted here: environment values reach the backend only
   * through `ensure` secret plans (see ensureSecret), so a pass-through field such as
   * `llm_configs.*.params` can never smuggle an arbitrary environment variable into a payload.
   */
  private async resolvePayload(
    payload: Record<string, unknown>,
    idMap: Map<string, number>,
    forKey: string,
  ): Promise<Record<string, unknown>> {
    const withTemplates = (await this.substituteTemplateRefs(payload)) as Record<string, unknown>;
    return substituteRefs(withTemplates, (refKey) => {
      const id = idMap.get(refKey);
      if (id === undefined) {
        throw new Error(
          `Internal ordering error: "${forKey}" references "${refKey}" before it was pushed. ` +
            'This is a compiler dependency-ordering bug.',
        );
      }
      return id;
    });
  }

  private async substituteTemplateRefs(value: unknown): Promise<unknown> {
    if (isModelRef(value)) {
      return this.resolveModelId(value.$model, value.provider);
    }
    if (isBuiltinToolRef(value)) {
      return this.resolveBuiltinToolId(value.$tool);
    }
    if (isStorageFileRef(value)) {
      return this.storage.resolveFileId(value.$storageFile);
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => this.substituteTemplateRefs(item)));
    }
    if (typeof value === 'object' && value !== null && !isSymbolicRefLike(value)) {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        result[key] = await this.substituteTemplateRefs(entry);
      }
      return result;
    }
    return value;
  }

  /**
   * `ensure` plans: org-level rows identified by name. Looked up on every push (a lock
   * entry could point at a deleted row) and created only when missing.
   */
  private async ensureEntity(plan: EntityPlan): Promise<{ backendId: number; created: boolean }> {
    const name = plan.remoteName ?? plan.name;
    switch (plan.kind) {
      case 'secret':
        return this.ensureSecret(plan, name);
      default:
        throw new Error(`Entity kind ${plan.kind} has no ensure path — compiler bug.`);
    }
  }

  /**
   * Store the value of the plan's environment variable as the org Secret `name`.
   * Secrets are immutable, so an existing secret is reused only when its visible tail
   * matches the current value; a mismatch means the env value was rotated and the user
   * must delete the old secret (it may still be referenced elsewhere). The value is
   * never logged, echoed, or written to the lockfile.
   */
  private async ensureSecret(plan: EntityPlan, name: string): Promise<{ backendId: number; created: boolean }> {
    const payload = plan.payload ?? {};
    const envRef = payload['value'];
    if (!isEnvRef(envRef)) {
      throw new Error(`Secret plan "${plan.key}" carries no {$env} value — compiler bug.`);
    }
    const value = this.readEnv(envRef.$env);
    const existing = await this.secrets.findByName(name);
    if (existing) {
      if (existing.tail !== secretTail(value)) {
        throw new Error(
          `Org secret "${name}" already exists but holds a different value than ${envRef.$env} ` +
            `(tail ${existing.tail ? `…${existing.tail}` : 'hidden'}). EpicStaff secrets are immutable — delete ` +
            `"${name}" in EpicStaff (Settings → Secrets) and push again, or restore the previous value of ${envRef.$env}.`,
        );
      }
      return { backendId: existing.id, created: false };
    }
    logger.info(`Creating org secret "${name}" from ${envRef.$env}`);
    return { backendId: (await this.secrets.create(name, value)).id, created: true };
  }

  private readEnv(envName: string): string {
    // Defense in depth — the flow-source schema already rejects these names.
    if (isReservedEnvName(envName)) {
      throw new Error(
        `Environment variable "${envName}" belongs to the MCP server's own configuration and cannot be stored ` +
          'as a flow credential. Export the provider key under its own name and reference that instead.',
      );
    }
    const resolved = readEnv(process.env, envName);
    if (resolved === undefined) {
      throw new Error(
        `Environment variable "${envName}" is not set for the MCP server. ` +
          'Secrets referenced in flow source must be provided in the plugin environment.',
      );
    }
    return resolved;
  }

  private async resolveBuiltinToolId(toolName: string): Promise<number> {
    if (!this.builtinToolIdByName) {
      const builtinTools = await this.tools.listBuiltinTools();
      this.builtinToolIdByName = new Map();
      for (const tool of builtinTools) {
        this.builtinToolIdByName.set(tool.name.toLowerCase(), tool.id);
      }
    }
    const id = this.builtinToolIdByName.get(toolName.toLowerCase());
    if (id === undefined) {
      throw new Error(
        `Built-in tool "${toolName}" not found. Use list_tools to see the available catalog.`,
      );
    }
    return id;
  }

  private async resolveModelId(modelName: string, providerHint?: string): Promise<number> {
    if (!this.modelIdByName) {
      const [models, providers] = await Promise.all([this.llm.listModels(), this.llm.listProviders()]);
      const providerName = new Map(providers.map((provider) => [provider.id, provider.name.toLowerCase()]));
      this.modelIdByName = new Map();
      for (const model of models) {
        const key = model.name.toLowerCase();
        // Provider-qualified key wins on cross-provider name collisions.
        this.modelIdByName.set(`${providerName.get(model.llm_provider) ?? ''}/${key}`, model.id);
        if (!this.modelIdByName.has(key)) this.modelIdByName.set(key, model.id);
      }
    }
    const id =
      (providerHint ? this.modelIdByName.get(`${providerHint.toLowerCase()}/${modelName.toLowerCase()}`) : undefined) ??
      this.modelIdByName.get(modelName.toLowerCase());
    if (id === undefined) {
      const available = [...this.modelIdByName.keys()].filter((key) => !key.includes('/')).slice(0, 20).join(', ');
      throw new Error(
        `LLM model "${modelName}" not found on the backend. Available models include: ${available}. ` +
          'Use list_llm_models to see all options.',
      );
    }
    return id;
  }

  private async resolveExisting(plan: EntityPlan): Promise<number> {
    const remoteName = plan.remoteName ?? plan.name;
    const found = await this.lookupByName(plan, remoteName);
    if (found === undefined) {
      throw new Error(
        `existing: "${remoteName}" (${plan.kind}) was not found in the active organization. ` +
          `Check the name with the matching list_* tool, or define it locally in the flow source.`,
      );
    }
    return found;
  }

  /** The locked id still exists and still names this entity (not a recycled / foreign id). */
  private async isLockedIdValid(plan: EntityPlan, backendId: number): Promise<boolean> {
    // Same id under another name = a foreign row; absent = deleted. Either way not ours.
    return (await this.lookupByName(plan, expectedRemoteName(plan))) === backendId;
  }

  private async lookupByName(plan: EntityPlan, remoteName: string): Promise<number | undefined> {
    const nameMatches = (candidate: { id: number; name?: string }): boolean =>
      (candidate.name ?? '').toLowerCase() === remoteName.toLowerCase();

    switch (plan.kind) {
      case 'llm_config': {
        const configs = await this.llm.listConfigs();
        return configs.find((config) => config.custom_name.toLowerCase() === remoteName.toLowerCase())?.id;
      }
      case 'tool_config':
        return (await this.tools.listToolConfigs()).find(nameMatches)?.id;
      case 'python_code_tool':
        return (await this.tools.listPythonCodeTools()).find(nameMatches)?.id;
      case 'mcp_tool':
        return (await this.tools.listMcpTools()).find(nameMatches)?.id;
      case 'knowledge_collection': {
        const collections = await this.knowledge.listCollections();
        const match = collections.find(
          (collection) => collection.collection_name.toLowerCase() === remoteName.toLowerCase(),
        );
        return (match?.collection_id ?? match?.id) as number | undefined;
      }
      case 'surface':
        return (await this.surfaces.list()).find(nameMatches)?.id;
      case 'agent_definition':
        return (await this.agentDefinitions.list()).find(nameMatches)?.id;
      default:
        return undefined;
    }
  }

  private async createEntity(plan: EntityPlan, payload: Record<string, unknown>): Promise<number> {
    try {
      return await this.createEntityRequest(plan, payload);
    } catch (error) {
      // Names are unique per organization (LLM configs, agents, tools, surfaces): without a lock
      // entry pointing at that row the pusher must not take it over — it may belong to other flows.
      if (
        error instanceof ApiError &&
        (error.status === 400 || error.status === 409) &&
        /already exists/i.test(`${error.message} ${error.bodyExcerpt ?? ''}`)
      ) {
        throw nameConflictError(plan);
      }
      throw error;
    }
  }

  private async createEntityRequest(plan: EntityPlan, payload: Record<string, unknown>): Promise<number> {
    logger.info(`Creating ${plan.kind} "${plan.name}"`);
    switch (plan.kind) {
      case 'llm_config':
        return (await this.llm.createConfig(payload as never)).id;
      case 'tool_config':
        return (await this.tools.createToolConfig(payload as never)).id;
      case 'python_code_tool':
        return (await this.tools.createPythonCodeTool(payload as never)).id;
      case 'mcp_tool':
        return (await this.tools.createMcpTool(payload as never)).id;
      case 'knowledge_collection': {
        const collectionName = (payload.collection_name as string | undefined) ?? plan.name;
        // Collection names are unique per org (UniqueConstraint(org, collection_name)), but the
        // backend does not reject a duplicate — SourceCollection.save() silently renames it to
        // "<name> (1)". Check first: a same-named collection without a lock entry belongs to someone
        // else, and uploading this flow's documents / attaching a RAG to it would mix knowledge
        // across flows. (Retries cannot duplicate: the lock is persisted after every create.)
        if ((await this.lookupByName(plan, collectionName)) !== undefined) {
          throw nameConflictError(plan);
        }
        const collection = await this.knowledge.createCollection(collectionName);
        const id = collection.collection_id ?? collection.id;
        if (id === undefined) {
          throw new Error('Backend did not return an id for the created collection.');
        }
        return id;
      }
      case 'surface':
        return (await this.surfaces.create(payload as never)).id;
      case 'agent_definition':
        return (await this.agentDefinitions.create(payload as never)).id;
      default:
        throw new Error(`Unknown entity kind: ${plan.kind as string}`);
    }
  }

  private async updateEntity(
    plan: EntityPlan,
    backendId: number,
    payload: Record<string, unknown>,
  ): Promise<number> {
    logger.info(`Updating ${plan.kind} "${plan.name}" (#${backendId})`);
    switch (plan.kind) {
      case 'llm_config':
        await this.llm.updateConfig(backendId, payload as never);
        return backendId;
      case 'python_code_tool':
        await this.tools.updatePythonCodeTool(backendId, payload as never);
        return backendId;
      case 'mcp_tool':
        await this.tools.updateMcpTool(backendId, payload as never);
        return backendId;
      case 'surface':
        await this.surfaces.update(backendId, payload as never);
        return backendId;
      case 'agent_definition':
        await this.agentDefinitions.update(backendId, payload as never);
        return backendId;
      case 'knowledge_collection':
        // Collection rename is the only mutable field; documents/RAG are handled in extras.
        return backendId;
      case 'tool_config':
        await this.tools.updateToolConfig(backendId, payload as never);
        return backendId;
      default:
        throw new Error(`Unknown entity kind: ${plan.kind as string}`);
    }
  }

  /** Upload new/changed documents (content-hashed) and attach + index the RAG strategy once. */
  private async pushCollectionExtras(
    plan: EntityPlan,
    collectionId: number,
    idMap: Map<string, number>,
    lock: FlowLock,
  ): Promise<FlowLock> {
    let currentLock = lock;

    const pendingUploads: string[] = [];
    for (const documentPath of plan.documents ?? []) {
      const hash = contentHash(readFileSync(documentPath, 'utf8'));
      const existing = getDocument(currentLock, documentPath);
      if (existing?.hash === hash && existing.uploadedTo === collectionId) {
        continue;
      }
      pendingUploads.push(documentPath);
      currentLock = setDocument(currentLock, documentPath, { hash, uploadedTo: collectionId });
    }
    if (pendingUploads.length > 0) {
      logger.info(`Uploading ${pendingUploads.length} document(s) to collection #${collectionId}`);
      await this.knowledge.uploadDocuments(collectionId, pendingUploads);
    }

    if (plan.rag) {
      const ragKey = `${plan.name}#rag`;
      const ragEntry = getEntity(currentLock, plan.section, ragKey);
      const ragHash = contentHash(plan.rag);
      if (!ragEntry || isEntityDirty(currentLock, plan.section, ragKey, ragHash)) {
        const embedderId = await this.resolveRagRef(plan.rag.embedder, idMap);
        let ragId: number;
        if (plan.rag.strategy === 'naive') {
          ragId = await this.knowledge.createNaiveRag(collectionId, embedderId);
          await this.applyNaiveChunking(ragId, plan.rag.document_chunking);
        } else {
          const llmId = await this.resolveRagRef(plan.rag.llm ?? 0, idMap);
          ragId = await this.knowledge.createGraphRag(collectionId, embedderId, llmId);
          if (plan.rag.index_config !== undefined) {
            await this.knowledge.updateGraphRagIndexConfig(ragId, plan.rag.index_config);
          }
        }
        await this.knowledge.startIndexing(ragId, plan.rag.strategy);
        logger.info(`Attached ${plan.rag.strategy} RAG (#${ragId}) to collection #${collectionId}; indexing started`);
        currentLock = setEntity(currentLock, plan.section, ragKey, { backendId: ragId, contentHash: ragHash });
      } else if (pendingUploads.length > 0) {
        // Docs changed under an existing RAG — re-index. For naive, new documents
        // need config rows first: the backend signal only creates them on RAG
        // creation, and indexing silently skips documents without a config.
        if (plan.rag.strategy === 'naive') {
          await this.applyNaiveChunking(ragEntry.backendId, plan.rag.document_chunking);
        }
        await this.knowledge.startIndexing(ragEntry.backendId, plan.rag.strategy);
        logger.info(`Re-indexing collection #${collectionId} after document changes`);
      }
    }

    return currentLock;
  }

  /** Config-row init + author chunking for a naive RAG; see KnowledgeApi.applyNaiveDocumentChunking. */
  private async applyNaiveChunking(
    naiveRagId: number,
    chunking: { chunk_size?: number; chunk_overlap?: number } | undefined,
  ): Promise<void> {
    const updated = await this.knowledge.applyNaiveDocumentChunking(naiveRagId, chunking);
    if (updated > 0) {
      logger.info(
        `Applied chunking (size=${chunking?.chunk_size ?? 'default'}, overlap=${chunking?.chunk_overlap ?? 'default'}) ` +
          `to ${updated} document config(s) of naive RAG #${naiveRagId}`,
      );
    }
  }

  private async resolveRagRef(ref: number | { $ref: string }, idMap: Map<string, number>): Promise<number> {
    if (typeof ref === 'number') return ref;
    const resolved = idMap.get(ref.$ref);
    if (resolved !== undefined) return resolved;

    // `embedders.*` is a virtual section: embedding configs are org-level, not flow-source
    // entities. `embedders.default` = the instance default; any other name = lookup by name.
    if (ref.$ref.startsWith('embedders.')) {
      // Tolerate a stray `existing:` prefix from older emitted artifacts — embedders
      // have no local/remote distinction, so the prefix is never part of the real name.
      const embedderName = ref.$ref.slice('embedders.'.length).replace(/^existing:/, '');
      if (embedderName === 'default') {
        return resolveDefaultEmbeddingConfigId(this.llm);
      }
      const configs = await this.llm.listEmbeddingConfigs();
      const named = configs.find(
        (config) => String(config.custom_name ?? config.name ?? '').toLowerCase() === embedderName.toLowerCase(),
      );
      if (named) return named.id as number;
      const available = configs
        .map((config) => String(config.custom_name ?? config.name ?? ''))
        .filter(Boolean)
        .join(', ');
      throw new Error(
        `Embedding config "${embedderName}" not found in the organization. ` +
          `Available embedding configs: ${available || '(none)'}. ` +
          'Fix knowledge.<name>.rag.embedder, or omit it to use the instance default.',
      );
    }

    throw new Error(`RAG config references "${ref.$ref}" which has not been pushed.`);
  }
}

/** Actionable error for a same-named org entity that flow.lock.json does not point at. */
function nameConflictError(plan: EntityPlan): Error {
  const name = expectedRemoteName(plan);
  return new Error(
    `A ${plan.kind.replaceAll('_', ' ')} named "${name}" already exists in this organization, and flow.lock.json ` +
      `does not point at it (${plan.key}). Reference it with { existing: "${name}" } to reuse it as-is, pull_flow ` +
      'the flow that owns it, or rename the entity in the flow source.',
  );
}

/** The name an upserted entity carries on the backend (its payload's name field). */
function expectedRemoteName(plan: EntityPlan): string {
  const payload = plan.payload ?? {};
  for (const field of ['custom_name', 'collection_name', 'name']) {
    const value = payload[field];
    if (typeof value === 'string' && value !== '') return value;
  }
  return plan.name;
}

function isSymbolicRefLike(value: object): boolean {
  return typeof (value as { $ref?: unknown }).$ref === 'string' && Object.keys(value).length === 1;
}
