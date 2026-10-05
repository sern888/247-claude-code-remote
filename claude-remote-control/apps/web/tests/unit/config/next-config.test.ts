import { describe, it, expect } from 'vitest';
import nextConfig from '../../../next.config.mjs';

interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

async function loadHeaderRules(): Promise<HeaderRule[]> {
  if (typeof nextConfig.headers !== 'function') {
    throw new Error('next.config.mjs must define headers()');
  }
  return nextConfig.headers();
}

function headersFor(rules: HeaderRule[], source: string): Record<string, string> {
  const rule = rules.find((candidate) => candidate.source === source);
  if (!rule) throw new Error(`No headers rule for ${source}`);
  return Object.fromEntries(rule.headers.map(({ key, value }) => [key, value]));
}

describe('next.config.mjs headers()', () => {
  it('never lets /sw.js be served from the HTTP cache and allows the root scope', async () => {
    const headers = headersFor(await loadHeaderRules(), '/sw.js');

    expect(headers).toEqual({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Service-Worker-Allowed': '/',
    });
  });

  it('sends baseline security headers on every route', async () => {
    const headers = headersFor(await loadHeaderRules(), '/:path*');

    expect(headers).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
  });

  // The dashboard opens WebSockets to arbitrary user-configured agent hosts:
  // a CSP would break that until connect-src is decided at product level.
  it('does not set a Content-Security-Policy', async () => {
    const rules = await loadHeaderRules();
    const keys = rules.flatMap((rule) => rule.headers.map((header) => header.key.toLowerCase()));

    expect(keys).not.toContain('content-security-policy');
    expect(keys).not.toContain('content-security-policy-report-only');
  });

  it('does not make every route uncacheable', async () => {
    const headers = headersFor(await loadHeaderRules(), '/:path*');

    expect(headers).not.toHaveProperty('Cache-Control');
  });
});
