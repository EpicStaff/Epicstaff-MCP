import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { logger } from '../util/logger.js';
/**
 * Persistent per-(host,email) state. Lives in ~/.es_mcp/, NOT inside the plugin
 * directory — plugin updates replace the plugin directory and would wipe it.
 * Holds the minted API key, so the file is written with mode 0600.
 */
const stateSchema = z.object({
    baseUrl: z.string(),
    email: z.string(),
    apiKey: z.string().nullable(),
    keyPrefix: z.string().nullable(),
    activeOrgId: z.number().nullable(),
});
/** Overridable for tests (ES_MCP_STATE_DIR); defaults to ~/.es_mcp. */
function stateDir() {
    return process.env.ES_MCP_STATE_DIR ?? join(homedir(), '.es_mcp');
}
export class StateStore {
    filePath;
    state;
    constructor(baseUrl, email) {
        this.filePath = join(stateDir(), stateFileName(baseUrl, email));
        this.state = this.loadOrInit(baseUrl, email);
    }
    get() {
        return this.state;
    }
    update(patch) {
        this.state = { ...this.state, ...patch };
        this.persist();
        return this.state;
    }
    loadOrInit(baseUrl, email) {
        const empty = { baseUrl, email, apiKey: null, keyPrefix: null, activeOrgId: null };
        if (!existsSync(this.filePath)) {
            return empty;
        }
        try {
            const parsed = stateSchema.safeParse(JSON.parse(readFileSync(this.filePath, 'utf8')));
            if (parsed.success && parsed.data.baseUrl === baseUrl && parsed.data.email === email) {
                return parsed.data;
            }
            logger.warn('State file did not match current config; starting fresh', { file: this.filePath });
            return empty;
        }
        catch (error) {
            logger.warn('Failed to read state file; starting fresh', error);
            return empty;
        }
    }
    persist() {
        mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
        writeFileSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
        // writeFileSync mode only applies on create; enforce on every write.
        chmodSync(this.filePath, 0o600);
    }
}
function stateFileName(baseUrl, email) {
    const host = new URL(baseUrl).host.replace(/[^a-zA-Z0-9.-]/g, '_');
    const emailHash = createHash('sha256').update(email).digest('hex').slice(0, 12);
    return `${host}-${emailHash}.json`;
}
