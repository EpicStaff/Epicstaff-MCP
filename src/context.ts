import type { Config, ConfigurationError } from './config.js';
import { type ApiClient, EpicStaffClient, unconfiguredClient } from './http/client.js';
import { AuthService } from './http/auth.js';
import { OrgService } from './http/org.js';
import { StateStore } from './state/store.js';

/** Shared services every MCP tool operates on. Built once at server startup. */
export interface AppContext {
  config: Config;
  store: StateStore;
  client: ApiClient;
  auth: AuthService;
  org: OrgService;
}

export function createContext(config: Config): AppContext {
  // Token-authenticated setups have no email; state (active org, key cache) is
  // still per-host, keyed under a fixed identity.
  const store = new StateStore(config.apiUrl, config.email ?? 'api-token');
  const client = new EpicStaffClient(config, store);
  const auth = new AuthService(config, store, client);
  const org = new OrgService(store, client);
  return { config, store, client, auth, org };
}

/**
 * Context for a server whose environment is invalid. Tools are still registered against it;
 * the first use of any backend-facing service throws the configuration error, which the
 * tool wrapper (runTool) returns to the model. Purely local tools (validate_flow, build_flow,
 * init_flow) never touch these services and keep working.
 */
export function createUnconfiguredContext(error: ConfigurationError): AppContext {
  const fail = (): never => {
    throw error;
  };
  return {
    get config(): Config {
      return fail();
    },
    get store(): StateStore {
      return fail();
    },
    // Not a throwing getter: API wrappers capture the client at registration time; the
    // stand-in rejects on the first request instead.
    client: unconfiguredClient(error),
    get auth(): AuthService {
      return fail();
    },
    get org(): OrgService {
      return fail();
    },
  };
}
