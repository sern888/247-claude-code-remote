/**
 * CLI Entry Point Tests
 *
 * `247 --version` must report the version from package.json rather than a
 * string that has to be kept in sync by hand.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const TEST_VERSION = '7.7.7-test';

describe('CLI entry point', () => {
  const originalArgv = process.argv;
  let written: string[];

  beforeEach(() => {
    vi.resetModules();

    vi.doMock('../../package.json', () => ({
      default: { version: TEST_VERSION },
    }));

    written = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    vi.doUnmock('../../package.json');
  });

  it('reports the version from package.json for --version', async () => {
    process.argv = ['node', '247', '--version'];

    await expect(import('../../src/index.js')).rejects.toThrow('process.exit(0)');

    expect(written.join('')).toContain(TEST_VERSION);
  });
});
