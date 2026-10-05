import { describe, it, expect } from 'vitest';
import { buildAllowedOrigins, isOriginAllowed } from '../../src/lib/origin.js';

describe('buildAllowedOrigins', () => {
  it('always allows the hosted dashboard and the local dev dashboard', () => {
    const allowed = buildAllowedOrigins({});

    expect(allowed.has('https://247.quivr.com')).toBe(true);
    expect(allowed.has('http://localhost:3001')).toBe(true);
    expect(allowed.has('http://127.0.0.1:3001')).toBe(true);
  });

  it('adds the configured dashboard, extra config entries and env entries as origins', () => {
    const allowed = buildAllowedOrigins({
      dashboardUrl: 'https://dash.example.com/api',
      configured: ['https://self-hosted.example.org/some/path'],
      envValue: 'https://a.example.com, https://b.example.com:8443',
    });

    expect(allowed.has('https://dash.example.com')).toBe(true);
    expect(allowed.has('https://self-hosted.example.org')).toBe(true);
    expect(allowed.has('https://a.example.com')).toBe(true);
    expect(allowed.has('https://b.example.com:8443')).toBe(true);
  });

  it('ignores entries that are not valid URLs', () => {
    const allowed = buildAllowedOrigins({ configured: ['not a url', ''], envValue: ',,' });

    expect(allowed.size).toBe(buildAllowedOrigins({}).size);
  });
});

describe('isOriginAllowed', () => {
  const allowed = buildAllowedOrigins({});

  it('allows requests without an Origin header (CLI, hooks, curl)', () => {
    expect(isOriginAllowed(undefined, allowed)).toBe(true);
  });

  it('allows a listed browser origin', () => {
    expect(isOriginAllowed('https://247.quivr.com', allowed)).toBe(true);
  });

  it.each([
    'https://evil.example.com',
    'http://247.quivr.com',
    'https://247.quivr.com.evil.example.com',
    'http://localhost:9999',
    'null',
    '',
  ])('rejects %j', (origin) => {
    expect(isOriginAllowed(origin, allowed)).toBe(false);
  });
});
