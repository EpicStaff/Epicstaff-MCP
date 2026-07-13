import type { Config } from './config.js';
import { EpicStaffClient } from './http/client.js';
import { AuthService } from './http/auth.js';
import { OrgService } from './http/org.js';
import { StateStore } from './state/store.js';

/** Shared services every MCP tool operates on. Built once at server startup. */
export interface AppContext {
  config: Config;
  store: StateStore;
  client: EpicStaffClient;
  auth: AuthService;
  org: OrgService;
}

export function createContext(config: Config): AppContext {
  const store = new StateStore(config.apiUrl, config.email);
  const client = new EpicStaffClient(config, store);
  const auth = new AuthService(config, store, client);
  const org = new OrgService(store, client);
  return { config, store, client, auth, org };
}
