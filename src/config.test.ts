import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig env contract', () => {
  it('accepts the EPICSTAFF_* names (the original plugin contract)', () => {
    const config = loadConfig({
      EPICSTAFF_BASE_URL: 'http://es.test',
      EPICSTAFF_EMAIL: 'dev@example.com',
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

  it('falls back to the legacy ES_* names', () => {
    const config = loadConfig({
      ES_URL: 'http://es.test',
      ES_EMAIL: 'dev@example.com',
      ES_PASSWORD: 'secret',
    });
    expect(config.apiUrl).toBe('http://es.test/api/');
    expect(config.email).toBe('dev@example.com');
  });

  it('EPICSTAFF_* wins over legacy ES_* when both are set', () => {
    const config = loadConfig({
      EPICSTAFF_BASE_URL: 'http://primary.test',
      ES_URL: 'http://legacy.test',
      EPICSTAFF_EMAIL: 'primary@example.com',
      ES_EMAIL: 'legacy@example.com',
      EPICSTAFF_PASSWORD: 'p1',
      ES_PASSWORD: 'p2',
    });
    expect(config.apiUrl).toBe('http://primary.test/api/');
    expect(config.email).toBe('primary@example.com');
    expect(config.password).toBe('p1');
  });

  it('treats empty strings as unset (plugin ${VAR} interpolation of missing vars)', () => {
    const config = loadConfig({
      EPICSTAFF_BASE_URL: 'http://es.test',
      EPICSTAFF_API_TOKEN: '',
      EPICSTAFF_EMAIL: '',
      EPICSTAFF_PASSWORD: '',
      ES_EMAIL: 'dev@example.com',
      ES_PASSWORD: 'secret',
    });
    expect(config.apiToken).toBeUndefined();
    expect(config.email).toBe('dev@example.com');
  });

  it('rejects a configuration with neither token nor credentials', () => {
    expect(() => loadConfig({ EPICSTAFF_BASE_URL: 'http://es.test' })).toThrow(
      /EPICSTAFF_API_TOKEN, or EPICSTAFF_EMAIL \+ EPICSTAFF_PASSWORD/,
    );
  });

  it('rejects a missing base URL with the EPICSTAFF_BASE_URL name in the message', () => {
    expect(() => loadConfig({ EPICSTAFF_API_TOKEN: 'k' })).toThrow(/EPICSTAFF_BASE_URL/);
  });

  it('rejects an incomplete credential pair', () => {
    expect(() =>
      loadConfig({ EPICSTAFF_BASE_URL: 'http://es.test', EPICSTAFF_EMAIL: 'dev@example.com' }),
    ).toThrow(/EPICSTAFF_PASSWORD is not set/);
  });
});
