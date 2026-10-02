import { describe, expect, it } from 'vitest';
import { ConfigurationError, isReservedEnvName, loadConfig, readEnv } from './config.js';

describe('loadConfig env contract', () => {
  it('accepts the EPICSTAFF_* names (the original plugin contract)', () => {
    const config = loadConfig({
      EPICSTAFF_BASE_URL: 'http://es.test',
      EPICSTAFF_USERNAME: 'dev@example.com',
      EPICSTAFF_PASSWORD: 'secret',
    });
    expect(config).toEqual({
      apiUrl: 'http://es.test/api/',
      email: 'dev@example.com',
      password: 'secret',
    });
  });

  it('accepts a token-only configuration (EPICSTAFF_API_TOKEN, no credentials)', () => {
    const config = loadConfig({
      EPICSTAFF_BASE_URL: 'http://es.test/api',
      EPICSTAFF_API_TOKEN: 'issued-key-123',
    });
    expect(config).toEqual({ apiUrl: 'http://es.test/api/', apiToken: 'issued-key-123' });
  });

  it('treats empty strings as unset (plugin ${VAR} interpolation of missing vars)', () => {
    const config = loadConfig({
      EPICSTAFF_BASE_URL: 'http://es.test',
      EPICSTAFF_API_TOKEN: '',
      EPICSTAFF_USERNAME: 'dev@example.com',
      EPICSTAFF_PASSWORD: 'secret',
    });
    expect(config.apiToken).toBeUndefined();
    expect(config.email).toBe('dev@example.com');
  });

  it('rejects a configuration with neither token nor credentials', () => {
    expect(() => loadConfig({ EPICSTAFF_BASE_URL: 'http://es.test' })).toThrow(
      /EPICSTAFF_API_TOKEN, or EPICSTAFF_USERNAME \+ EPICSTAFF_PASSWORD/,
    );
  });

  it('rejects a missing base URL with the EPICSTAFF_BASE_URL name in the message', () => {
    expect(() => loadConfig({ EPICSTAFF_API_TOKEN: 'k' })).toThrow(/EPICSTAFF_BASE_URL/);
  });

  it('rejects an incomplete credential pair', () => {
    expect(() =>
      loadConfig({ EPICSTAFF_BASE_URL: 'http://es.test', EPICSTAFF_USERNAME: 'dev@example.com' }),
    ).toThrow(/EPICSTAFF_PASSWORD is not set/);
  });
});

describe('readEnv', () => {
  it('treats unexpanded ${VAR} / ${VAR:-} placeholders as unset (Claude Code passes them verbatim)', () => {
    expect(readEnv({ NAME: '${EPICSTAFF_USERNAME}' }, 'NAME')).toBeUndefined();
    expect(readEnv({ NAME: '${EPICSTAFF_USERNAME:-}' }, 'NAME')).toBeUndefined();
    expect(readEnv({ NAME: '${EPICSTAFF_BASE_URL:-http://x}' }, 'NAME')).toBeUndefined();
    expect(readEnv({ NAME: '  ${EPICSTAFF_PASSWORD}  ' }, 'NAME')).toBeUndefined();
  });

  it('treats empty and whitespace-only values as unset', () => {
    expect(readEnv({ NAME: '' }, 'NAME')).toBeUndefined();
    expect(readEnv({ NAME: '   ' }, 'NAME')).toBeUndefined();
    expect(readEnv({}, 'NAME')).toBeUndefined();
  });

  it('keeps real values, including ones that merely contain a dollar sign', () => {
    expect(readEnv({ NAME: 'p@ss$word' }, 'NAME')).toBe('p@ss$word');
    expect(readEnv({ NAME: 'abc${x}def' }, 'NAME')).toBe('abc${x}def');
  });

  it('loadConfig ignores a placeholder API token and falls back to credentials', () => {
    const config = loadConfig({
      EPICSTAFF_BASE_URL: 'http://es.test',
      EPICSTAFF_API_TOKEN: '${EPICSTAFF_API_TOKEN}',
      EPICSTAFF_USERNAME: 'dev@example.com',
      EPICSTAFF_PASSWORD: 'secret',
    });
    expect(config.apiToken).toBeUndefined();
  });

  it('loadConfig reports placeholder-only settings as missing, as a ConfigurationError', () => {
    expect(() =>
      loadConfig({
        EPICSTAFF_BASE_URL: '${EPICSTAFF_BASE_URL}',
        EPICSTAFF_USERNAME: '${EPICSTAFF_USERNAME}',
        EPICSTAFF_PASSWORD: '${EPICSTAFF_PASSWORD}',
      }),
    ).toThrow(ConfigurationError);
  });
});

describe('isReservedEnvName', () => {
  it('reserves the MCP server own variables', () => {
    expect(isReservedEnvName('EPICSTAFF_PASSWORD')).toBe(true);
    expect(isReservedEnvName('EPICSTAFF_API_TOKEN')).toBe(true);
    expect(isReservedEnvName('ES_MCP_STATE_DIR')).toBe(true);
    expect(isReservedEnvName('OPENAI_API_KEY')).toBe(false);
    expect(isReservedEnvName('MY_EPICSTAFF_KEY')).toBe(false);
  });

  it('is case-insensitive (Windows env lookups ignore case)', () => {
    expect(isReservedEnvName('epicstaff_password')).toBe(true);
    expect(isReservedEnvName('Es_Mcp_State_Dir')).toBe(true);
  });
});
