import type { AppContext } from '../context.js';
import type { BuildArtifact, EntityPlan } from '../compiler/artifact.js';
import { substituteRefs } from '../compiler/artifact.js';
import { isBuiltinToolRef, isEnvRef, isModelRef, isStorageFileRef } from '../compiler/template-refs.js';
import { StorageApi } from '../api/storage.js';
import { AgentDefinitionsApi } from '../api/agent-definitions.js';
import { KnowledgeApi } from '../api/knowledge.js';
import { LegacyCrewApi } from '../api/legacy-crew.js';
import { LlmApi } from '../api/llm.js';
import { SurfacesApi } from '../api/surfaces.js';
import { ToolsApi } from '../api/tools.js';
import {
  type FlowLock,
  contentHash,
  getDocument,
  getEntity,
  isEntityDirty,
  setDocument,
  setEntity,
} from '../flow-source/lockfile.js';
import { logger } from '../util/logger.js';
import { readFileSync } from 'node:fs';

/**
 * Entity pusher — materializes the dependency tree of a BuildArtifact in order
 * (llm-configs → tools → knowledge → surfaces → agent-definitions → crews),
 * following the reuse-first policy:
 *   lockfile hit + clean hash → reuse id;
 *   lockfile hit + dirty hash → update in place;
 *   `existing:` reference     → resolve by remote name, never modify;
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
}


export class EntityPusher {
  private readonly llm;
  private readonly tools;
  private readonly knowledge;
  private readonly surfaces;
  private readonly agentDefinitions;
  private readonly crews;
  private readonly storage;
  private modelIdByName: Map<string, number> | null = null;
  private builtinToolIdByName: Map<string, number> | null = null;

  constructor(private readonly context: AppContext) {
    this.llm = new LlmApi(context.client);
    this.tools = new ToolsApi(context.client);
    this.knowledge = new KnowledgeApi(context.client);
    this.surfaces = new SurfacesApi(context.client);
    this.agentDefinitions = new AgentDefinitionsApi(context.client);
    this.crews = new LegacyCrewApi(context.client);
    this.storage = new StorageApi(context.client);
  }

  async push(artifact: BuildArtifact, lock: FlowLock): Promise<EntityPushResult> {
    const idMap = new Map<string, number>();
    const actions: EntityPushAction[] = [];
    let currentLock = lock;

    for (const plan of artifact.entities) {
      if (plan.action === 'resolve-existing') {
        const backendId = await this.resolveExisting(plan);
        idMap.set(plan.key, backendId);
        actions.push({ key: plan.key, kind: plan.kind, action: 'resolved-existing', backendId });
        continue;
      }

      const resolvedPayload = await this.resolvePayload(plan.payload ?? {}, idMap, plan.key);
      const hash = plan.contentHash ?? contentHash(plan.payload ?? {});
      const lockEntry = getEntity(currentLock, plan.section, plan.name);

      let backendId: number;
      let action: EntityPushAction['action'];
      if (lockEntry && !isEntityDirty(currentLock, plan.section, plan.name, hash)) {
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

      if (plan.kind === 'knowledge_collection') {
        currentLock = await this.pushCollectionExtras(plan, backendId, idMap, currentLock);
      }
    }

    return { idMap, lock: currentLock, actions };
  }

  /**
   * Substitute every placeholder kind the compiler emits:
   * `{$ref}` (entity pushed earlier in this walk), `{$model}` (LLM model by name),
   * `{$env}` (environment variable — secrets never live in flow source),
   * `{$tool}` (built-in catalog tool by name), `{$storageFile}` (org storage path).
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
    if (isEnvRef(value)) {
      const resolved = process.env[value.$env];
      if (resolved === undefined) {
        throw new Error(
          `Environment variable "${value.$env}" is not set for the MCP server. ` +
            'Secrets referenced in flow source ({$env}) must be provided in the plugin environment.',
        );
      }
      return resolved;
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

  private async resolveBuiltinToolId(toolName: string): Promise<number> {
    if (!this.builtinToolIdByName) {
      const builtinTools = await this.tools.listBuiltinTools();
      this.builtinToolIdByName = new Map();
      for (const tool of builtinTools) {
        this.builtinToolIdByName.set(tool.name.toLowerCase(), tool.id);
        if (tool.name_alias) this.builtinToolIdByName.set(tool.name_alias.toLowerCase(), tool.id);
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
      case 'crew':
        return (await this.crews.listCrews()).find(nameMatches)?.id;
      default:
        return undefined;
    }
  }

  private async createEntity(plan: EntityPlan, payload: Record<string, unknown>): Promise<number> {
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
        // Collections have no unique-name constraint and the lockfile is only
        // persisted after the whole entity walk succeeds, so a mid-push failure
        // (e.g. a later RAG/indexing error) would otherwise create a fresh
        // duplicate on every retry. Reuse an existing same-named collection.
        const existingId = await this.lookupByName(plan, collectionName);
        if (existingId !== undefined) {
          logger.info(`Reusing existing collection "${collectionName}" (#${existingId})`);
          return existingId;
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
      case 'crew':
        return (await this.crews.createCrew(payload as never)).id;
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
      case 'crew':
        // No update path ported — recreate semantics would break references; keep the old id.
        logger.warn(`Update for ${plan.kind} is not supported — keeping existing #${backendId} unchanged.`);
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
        } else {
          const llmId = await this.resolveRagRef(plan.rag.llm ?? 0, idMap);
          ragId = await this.knowledge.createGraphRag(collectionId, embedderId, llmId);
        }
        await this.knowledge.startIndexing(ragId, plan.rag.strategy);
        logger.info(`Attached ${plan.rag.strategy} RAG (#${ragId}) to collection #${collectionId}; indexing started`);
        currentLock = setEntity(currentLock, plan.section, ragKey, { backendId: ragId, contentHash: ragHash });
      } else if (pendingUploads.length > 0) {
        // Docs changed under an existing RAG — re-index.
        await this.knowledge.startIndexing(ragEntry.backendId, plan.rag.strategy);
        logger.info(`Re-indexing collection #${collectionId} after document changes`);
      }
    }

    return currentLock;
  }

  private async resolveRagRef(ref: number | { $ref: string }, idMap: Map<string, number>): Promise<number> {
    if (typeof ref === 'number') return ref;
    const resolved = idMap.get(ref.$ref);
    if (resolved !== undefined) return resolved;

    // `embedders.*` is a virtual section: embedding configs are org-level, not flow-source
    // entities. `embedders.default` = the org default; any other name = lookup by name.
    if (ref.$ref.startsWith('embedders.')) {
      // Tolerate a stray `existing:` prefix from older emitted artifacts — embedders
      // have no local/remote distinction, so the prefix is never part of the real name.
      const embedderName = ref.$ref.slice('embedders.'.length).replace(/^existing:/, '');
      const configs = await this.llm.listEmbeddingConfigs();
      if (embedderName === 'default') {
        return this.resolveDefaultEmbedderId(configs);
      }
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
          'Fix knowledge.<name>.rag.embedder, or omit it to use the org default.',
      );
    }

    throw new Error(`RAG config references "${ref.$ref}" which has not been pushed.`);
  }

  /**
   * Resolve "the org default embedder" to a concrete EmbeddingConfig id.
   *
   * `default-embedding-config/` is NOT a pointer to a selectable EmbeddingConfig
   * row — it returns only `{model, task_type, api_key}` (no id). So we resolve by
   * matching that default's embedding *model* to a config that uses it; if that is
   * ambiguous or absent we fall back to the sole config, and only error when the
   * choice is genuinely undecidable.
   */
  private async resolveDefaultEmbedderId(configs: Array<Record<string, unknown>>): Promise<number> {
    if (configs.length === 0) {
      throw new Error(
        'No embedding config exists in this organization — create one in EpicStaff settings ' +
          '(knowledge indexing needs an embedder).',
      );
    }

    const defaultConfig = await this.context.client
      .get<{ model?: number } | undefined>('default-embedding-config/')
      .catch(() => undefined);
    const defaultModelId = defaultConfig?.model;
    if (defaultModelId !== undefined) {
      const byModel = configs.find((config) => config.model === defaultModelId);
      if (byModel) return byModel.id as number;
    }

    if (configs.length === 1) return configs[0]!.id as number;

    const available = configs
      .map((config) => String(config.custom_name ?? config.name ?? ''))
      .filter(Boolean)
      .join(', ');
    throw new Error(
      'Cannot pick a default embedding config: the organization has several and none matches the ' +
        `configured default embedding model. Set knowledge.<name>.rag.embedder to one of: ${available}.`,
    );
  }
}

function isSymbolicRefLike(value: object): boolean {
  return typeof (value as { $ref?: unknown }).$ref === 'string' && Object.keys(value).length === 1;
}
