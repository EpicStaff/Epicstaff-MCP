import { substituteRefs } from '../compiler/artifact.js';
import { isBuiltinToolRef, isEnvRef, isModelRef, isStorageFileRef } from '../compiler/template-refs.js';
import { StorageApi } from '../api/storage.js';
import { AgentDefinitionsApi } from '../api/agent-definitions.js';
import { KnowledgeApi } from '../api/knowledge.js';
import { LegacyCrewApi } from '../api/legacy-crew.js';
import { LlmApi } from '../api/llm.js';
import { SurfacesApi } from '../api/surfaces.js';
import { ToolsApi } from '../api/tools.js';
import { contentHash, getDocument, getEntity, isEntityDirty, setDocument, setEntity, } from '../flow-source/lockfile.js';
import { logger } from '../util/logger.js';
import { readFileSync } from 'node:fs';
export class EntityPusher {
    context;
    llm;
    tools;
    knowledge;
    surfaces;
    agentDefinitions;
    crews;
    storage;
    modelIdByName = null;
    builtinToolIdByName = null;
    constructor(context) {
        this.context = context;
        this.llm = new LlmApi(context.client);
        this.tools = new ToolsApi(context.client);
        this.knowledge = new KnowledgeApi(context.client);
        this.surfaces = new SurfacesApi(context.client);
        this.agentDefinitions = new AgentDefinitionsApi(context.client);
        this.crews = new LegacyCrewApi(context.client);
        this.storage = new StorageApi(context.client);
    }
    async push(artifact, lock) {
        const idMap = new Map();
        const actions = [];
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
            let backendId;
            let action;
            if (lockEntry && !isEntityDirty(currentLock, plan.section, plan.name, hash)) {
                backendId = lockEntry.backendId;
                action = 'reused';
            }
            else if (lockEntry) {
                backendId = await this.updateEntity(plan, lockEntry.backendId, resolvedPayload);
                action = 'updated';
            }
            else {
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
    async resolvePayload(payload, idMap, forKey) {
        const withTemplates = (await this.substituteTemplateRefs(payload));
        return substituteRefs(withTemplates, (refKey) => {
            const id = idMap.get(refKey);
            if (id === undefined) {
                throw new Error(`Internal ordering error: "${forKey}" references "${refKey}" before it was pushed. ` +
                    'This is a compiler dependency-ordering bug.');
            }
            return id;
        });
    }
    async substituteTemplateRefs(value) {
        if (isModelRef(value)) {
            return this.resolveModelId(value.$model, value.provider);
        }
        if (isEnvRef(value)) {
            const resolved = process.env[value.$env];
            if (resolved === undefined) {
                throw new Error(`Environment variable "${value.$env}" is not set for the MCP server. ` +
                    'Secrets referenced in flow source ({$env}) must be provided in the plugin environment.');
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
            const result = {};
            for (const [key, entry] of Object.entries(value)) {
                result[key] = await this.substituteTemplateRefs(entry);
            }
            return result;
        }
        return value;
    }
    async resolveBuiltinToolId(toolName) {
        if (!this.builtinToolIdByName) {
            const builtinTools = await this.tools.listBuiltinTools();
            this.builtinToolIdByName = new Map();
            for (const tool of builtinTools) {
                this.builtinToolIdByName.set(tool.name.toLowerCase(), tool.id);
                if (tool.name_alias)
                    this.builtinToolIdByName.set(tool.name_alias.toLowerCase(), tool.id);
            }
        }
        const id = this.builtinToolIdByName.get(toolName.toLowerCase());
        if (id === undefined) {
            throw new Error(`Built-in tool "${toolName}" not found. Use list_tools to see the available catalog.`);
        }
        return id;
    }
    async resolveModelId(modelName, providerHint) {
        if (!this.modelIdByName) {
            const [models, providers] = await Promise.all([this.llm.listModels(), this.llm.listProviders()]);
            const providerName = new Map(providers.map((provider) => [provider.id, provider.name.toLowerCase()]));
            this.modelIdByName = new Map();
            for (const model of models) {
                const key = model.name.toLowerCase();
                // Provider-qualified key wins on cross-provider name collisions.
                this.modelIdByName.set(`${providerName.get(model.llm_provider) ?? ''}/${key}`, model.id);
                if (!this.modelIdByName.has(key))
                    this.modelIdByName.set(key, model.id);
            }
        }
        const id = (providerHint ? this.modelIdByName.get(`${providerHint.toLowerCase()}/${modelName.toLowerCase()}`) : undefined) ??
            this.modelIdByName.get(modelName.toLowerCase());
        if (id === undefined) {
            const available = [...this.modelIdByName.keys()].filter((key) => !key.includes('/')).slice(0, 20).join(', ');
            throw new Error(`LLM model "${modelName}" not found on the backend. Available models include: ${available}. ` +
                'Use list_llm_models to see all options.');
        }
        return id;
    }
    async resolveExisting(plan) {
        const remoteName = plan.remoteName ?? plan.name;
        const found = await this.lookupByName(plan, remoteName);
        if (found === undefined) {
            throw new Error(`existing: "${remoteName}" (${plan.kind}) was not found in the active organization. ` +
                `Check the name with the matching list_* tool, or define it locally in the flow source.`);
        }
        return found;
    }
    async lookupByName(plan, remoteName) {
        const nameMatches = (candidate) => (candidate.name ?? '').toLowerCase() === remoteName.toLowerCase();
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
                const match = collections.find((collection) => collection.collection_name.toLowerCase() === remoteName.toLowerCase());
                return (match?.collection_id ?? match?.id);
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
    async createEntity(plan, payload) {
        logger.info(`Creating ${plan.kind} "${plan.name}"`);
        switch (plan.kind) {
            case 'llm_config':
                return (await this.llm.createConfig(payload)).id;
            case 'tool_config':
                return (await this.tools.createToolConfig(payload)).id;
            case 'python_code_tool':
                return (await this.tools.createPythonCodeTool(payload)).id;
            case 'mcp_tool':
                return (await this.tools.createMcpTool(payload)).id;
            case 'knowledge_collection': {
                const collection = await this.knowledge.createCollection(payload.collection_name ?? plan.name);
                const id = collection.collection_id ?? collection.id;
                if (id === undefined) {
                    throw new Error('Backend did not return an id for the created collection.');
                }
                return id;
            }
            case 'surface':
                return (await this.surfaces.create(payload)).id;
            case 'agent_definition':
                return (await this.agentDefinitions.create(payload)).id;
            case 'crew':
                return (await this.crews.createCrew(payload)).id;
            default:
                throw new Error(`Unknown entity kind: ${plan.kind}`);
        }
    }
    async updateEntity(plan, backendId, payload) {
        logger.info(`Updating ${plan.kind} "${plan.name}" (#${backendId})`);
        switch (plan.kind) {
            case 'llm_config':
                await this.llm.updateConfig(backendId, payload);
                return backendId;
            case 'python_code_tool':
                await this.tools.updatePythonCodeTool(backendId, payload);
                return backendId;
            case 'mcp_tool':
                await this.tools.updateMcpTool(backendId, payload);
                return backendId;
            case 'surface':
                await this.surfaces.update(backendId, payload);
                return backendId;
            case 'agent_definition':
                await this.agentDefinitions.update(backendId, payload);
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
                throw new Error(`Unknown entity kind: ${plan.kind}`);
        }
    }
    /** Upload new/changed documents (content-hashed) and attach + index the RAG strategy once. */
    async pushCollectionExtras(plan, collectionId, idMap, lock) {
        let currentLock = lock;
        const pendingUploads = [];
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
                let ragId;
                if (plan.rag.strategy === 'naive') {
                    const created = await this.knowledge.createNaiveRag(collectionId, embedderId);
                    ragId = (created.rag_id ?? created.id);
                }
                else {
                    const llmId = await this.resolveRagRef(plan.rag.llm ?? 0, idMap);
                    const created = await this.knowledge.createGraphRag(collectionId, embedderId, llmId);
                    ragId = (created.rag_id ?? created.id);
                }
                await this.knowledge.startIndexing(ragId, plan.rag.strategy);
                logger.info(`Attached ${plan.rag.strategy} RAG (#${ragId}) to collection #${collectionId}; indexing started`);
                currentLock = setEntity(currentLock, plan.section, ragKey, { backendId: ragId, contentHash: ragHash });
            }
            else if (pendingUploads.length > 0) {
                // Docs changed under an existing RAG — re-index.
                await this.knowledge.startIndexing(ragEntry.backendId, plan.rag.strategy);
                logger.info(`Re-indexing collection #${collectionId} after document changes`);
            }
        }
        return currentLock;
    }
    async resolveRagRef(ref, idMap) {
        if (typeof ref === 'number')
            return ref;
        const resolved = idMap.get(ref.$ref);
        if (resolved !== undefined)
            return resolved;
        // `embedders.*` is a virtual section: embedding configs are org-level, not flow-source
        // entities. `embedders.default` = the org default; any other name = lookup by name.
        if (ref.$ref.startsWith('embedders.')) {
            const embedderName = ref.$ref.slice('embedders.'.length);
            const configs = await this.llm.listEmbeddingConfigs();
            if (embedderName === 'default') {
                const defaultConfig = await this.context.client
                    .get('default-embedding-config/')
                    .catch(() => undefined);
                const id = defaultConfig?.id ?? configs[0]?.id;
                if (id !== undefined)
                    return id;
                throw new Error('No embedding config exists in this organization — create one in EpicStaff settings ' +
                    '(knowledge indexing needs an embedder).');
            }
            const named = configs.find((config) => String(config.custom_name ?? config.name ?? '').toLowerCase() === embedderName.toLowerCase());
            if (named)
                return named.id;
            throw new Error(`Embedding config "${embedderName}" not found in the organization.`);
        }
        throw new Error(`RAG config references "${ref.$ref}" which has not been pushed.`);
    }
}
function isSymbolicRefLike(value) {
    return typeof value.$ref === 'string' && Object.keys(value).length === 1;
}
