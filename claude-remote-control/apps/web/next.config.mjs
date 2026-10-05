import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Read version from package.json at build time
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
const APP_VERSION = pkg.version;

// Baseline security headers for every route.
// NOTE: no Content-Security-Policy on purpose: the dashboard opens WebSockets to arbitrary,
// user-configured agent hosts, so a CSP (connect-src) needs a product decision first.
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

// The service worker must never be served from the HTTP cache (a stale worker would keep
// running old push/deeplink code) and is allowed to control the whole origin.
const SERVICE_WORKER_HEADERS = [
  { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
  { key: 'Service-Worker-Allowed', value: '/' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  async headers() {
    return [
      { source: '/:path*', headers: SECURITY_HEADERS },
      { source: '/sw.js', headers: SERVICE_WORKER_HEADERS },
    ];
  },
  // Inject version at build time for auto-update system
  env: {
    NEXT_PUBLIC_APP_VERSION: APP_VERSION,
  },
};

export default nextConfig;
