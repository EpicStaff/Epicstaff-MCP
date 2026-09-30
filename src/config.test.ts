import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

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
