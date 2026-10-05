import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import vm from 'vm';

const PUBLIC_DIR = path.resolve(__dirname, '../../../public');
const SW_PATH = path.join(PUBLIC_DIR, 'sw.js');

/** Matches `addEventListener('<type>'` with either quote style (formatter independent). */
function listenerPattern(type: string): RegExp {
  return new RegExp(`addEventListener\\(\\s*['"]${type}['"]`);
}

describe('public/sw.js', () => {
  // sw.js is versioned and edited by hand, so nothing else compiles it before it ships.
  // A syntax error makes the browser reject the whole service worker (no PWA, no push).
  it('parses as valid JavaScript so browsers can install the service worker', () => {
    const source = readFileSync(SW_PATH, 'utf-8');

    expect(() => new vm.Script(source, { filename: 'sw.js' })).not.toThrow();
  });

  it('keeps the notification handlers the dashboard relies on', () => {
    const source = readFileSync(SW_PATH, 'utf-8');

    expect(source).toMatch(listenerPattern('push'));
    expect(source).toMatch(listenerPattern('notificationclick'));
    expect(source).toMatch(listenerPattern('message'));
    // Quoted, so that e.g. CHECK_NOTIFICATION_DEEPLINK cannot stand in for NOTIFICATION_DEEPLINK
    for (const messageType of [
      'CHECK_NOTIFICATION_DEEPLINK',
      'NOTIFICATION_DEEPLINK',
      'NOTIFICATION_CLICK',
      'PUSH_NOTIFICATION_FOREGROUND',
    ]) {
      expect(source).toMatch(new RegExp(`['"]${messageType}['"]`));
    }
  });

  it('takes over from the previous worker on install and activate', () => {
    const source = readFileSync(SW_PATH, 'utf-8');

    expect(source).toMatch(listenerPattern('install'));
    expect(source).toMatch(listenerPattern('activate'));
  });

  // A stale precache manifest lists build-hashed URLs that 404 after the next deploy, which
  // makes the install fail. The worker must not carry one.
  it('has no precache manifest', () => {
    const source = readFileSync(SW_PATH, 'utf-8');

    expect(source).not.toContain('/_next/static/');
    expect(source).not.toContain('__SW_MANIFEST');
    expect(source).not.toContain('__WB_MANIFEST');
    expect(source).not.toContain('precacheEntries');
  });

  // No fetch listener means no request is ever answered from a cache: no stale JS,
  // no cached /api/* responses.
  it('has no fetch listener and never answers requests itself', () => {
    const source = readFileSync(SW_PATH, 'utf-8');

    expect(source).not.toMatch(listenerPattern('fetch'));
    expect(source).not.toContain('onfetch');
    expect(source).not.toContain('respondWith');
  });

  it('only references icons that exist in public/', () => {
    const source = readFileSync(SW_PATH, 'utf-8');
    const iconPaths = [...source.matchAll(/['"](\/[\w./-]+\.(?:png|ico|svg|jpg|webp))['"]/g)].map(
      (match) => match[1]
    );

    expect(iconPaths.length).toBeGreaterThan(0);
    for (const iconPath of iconPaths) {
      expect(existsSync(path.join(PUBLIC_DIR, iconPath)), `${iconPath} exists`).toBe(true);
    }
  });
});
