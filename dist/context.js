import { EpicStaffClient } from './http/client.js';
import { AuthService } from './http/auth.js';
import { OrgService } from './http/org.js';
import { StateStore } from './state/store.js';
export function createContext(config) {
    const store = new StateStore(config.apiUrl, config.email);
    const client = new EpicStaffClient(config, store);
    const auth = new AuthService(config, store, client);
    const org = new OrgService(store, client);
    return { config, store, client, auth, org };
}
