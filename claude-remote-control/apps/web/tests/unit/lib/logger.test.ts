import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type ConsoleMethod = 'debug' | 'info' | 'warn' | 'error';

async function loadLogger(nodeEnv: string) {
  vi.stubEnv('NODE_ENV', nodeEnv);
  vi.resetModules();
  return import('@/lib/logger');
}

describe('createLogger', () => {
  let spies: Record<ConsoleMethod, ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    spies = {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each<ConsoleMethod>(['debug', 'info', 'warn', 'error'])(
    'writes %s messages to the matching console method in development',
    async (level) => {
      const { createLogger } = await loadLogger('development');

      createLogger('Test')[level]('hello');

      expect(spies[level]).toHaveBeenCalledTimes(1);
      const line = String(spies[level].mock.calls[0][0]);
      expect(line).toContain(`[${level.toUpperCase()}] [Test] hello`);
    }
  );

  it('drops debug and info messages outside development', async () => {
    const { createLogger } = await loadLogger('production');
    const log = createLogger('Test');

    log.debug('quiet');
    log.info('quiet');

    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.info).not.toHaveBeenCalled();
  });

  it('keeps warnings and errors outside development', async () => {
    const { createLogger } = await loadLogger('production');
    const log = createLogger('Test');

    log.warn('careful', { attempt: 2 });
    log.error('broken', new Error('boom'));

    expect(String(spies.warn.mock.calls[0][0])).toContain('[Test] careful {"attempt":2}');
    expect(String(spies.error.mock.calls[0][0])).toContain('"errorMessage":"boom"');
  });

  it('logs non-Error values passed as the error', async () => {
    const { createLogger } = await loadLogger('production');

    createLogger('Test').error('broken', 'plain text', { step: 1 });

    const line = String(spies.error.mock.calls[0][0]);
    expect(line).toContain('"step":1');
    expect(line).toContain('"error":"plain text"');
  });
});
