import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import WebSocket from 'ws';
import { execFile, execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import type { AddressInfo } from 'net';
import { logger } from '../../src/logger.js';
import { getSession } from '../../src/db/sessions.js';

// Mock config
const mockConfig = {
  machine: { id: 'test-machine', name: 'Test Machine' },
  projects: {
    basePath: '/tmp/test-projects',
    whitelist: ['allowed-project'],
  },
  editor: {
    enabled: false,
    portRange: { start: 4680, end: 4699 },
    idleTimeout: 60000,
  },
  dashboard: {
    apiUrl: 'http://localhost:3001/api',
    apiKey: 'test-key',
  },
};

vi.mock('../../src/config.js', () => ({
  config: mockConfig,
  loadConfig: () => mockConfig,
  default: mockConfig,
}));

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readdir: vi.fn().mockResolvedValue([]),
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
  rm: vi.fn().mockResolvedValue(undefined),
}));

// Mock database modules
vi.mock('../../src/db/index.js', () => ({
  initDatabase: vi.fn().mockReturnValue({}),
  closeDatabase: vi.fn(),
  migrateEnvironmentsFromJson: vi.fn().mockReturnValue(false),
  RETENTION_CONFIG: {
    sessionMaxAge: 24 * 60 * 60 * 1000,
    historyMaxAge: 7 * 24 * 60 * 60 * 1000,
    cleanupInterval: 60 * 60 * 1000,
  },
}));

vi.mock('../../src/db/environments.js', () => ({
  getEnvironmentsMetadata: vi.fn().mockReturnValue([]),
  getEnvironmentMetadata: vi.fn().mockReturnValue(undefined),
  getEnvironment: vi.fn().mockReturnValue(undefined),
  createEnvironment: vi.fn().mockReturnValue({ id: 'test-env' }),
  updateEnvironment: vi.fn().mockReturnValue(null),
  deleteEnvironment: vi.fn().mockReturnValue(false),
  getEnvironmentVariables: vi.fn().mockReturnValue({}),
  setSessionEnvironment: vi.fn(),
  getSessionEnvironment: vi.fn().mockReturnValue(undefined),
  clearSessionEnvironment: vi.fn(),
  ensureDefaultEnvironment: vi.fn(),
}));

vi.mock('../../src/db/sessions.js', () => ({
  getAllSessions: vi.fn().mockReturnValue([]),
  getSession: vi.fn().mockReturnValue(null),
  upsertSession: vi.fn(),
  deleteSession: vi.fn().mockReturnValue(true),
  cleanupStaleSessions: vi.fn().mockReturnValue(0),
  reconcileWithTmux: vi.fn(),
  toHookStatus: vi.fn().mockReturnValue({}),
  clearSessionEnvironmentId: vi.fn(),
}));

vi.mock('../../src/db/history.js', () => ({
  recordStatusChange: vi.fn(),
  getSessionHistory: vi.fn().mockReturnValue([]),
  cleanupOldHistory: vi.fn().mockReturnValue(0),
}));

// Create shared mock terminal
let mockTerminal: any;
const createMockTerminal = () => {
  const terminal = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    detach: vi.fn(),
    captureHistory: vi.fn().mockResolvedValue('$ echo hello\nhello\n$ '),
    isExistingSession: vi.fn().mockReturnValue(false),
    onReady: vi.fn((cb: () => void) => cb()), // Mock terminal is always ready
    _dataCallbacks: [] as ((data: string) => void)[],
    _exitCallbacks: [] as ((info: { exitCode: number }) => void)[],
    onData: vi.fn((cb) => terminal._dataCallbacks.push(cb)),
    onExit: vi.fn((cb) => terminal._exitCallbacks.push(cb)),
    emitData: (data: string) => terminal._dataCallbacks.forEach((cb) => cb(data)),
    emitExit: (info: { exitCode: number }) => terminal._exitCallbacks.forEach((cb) => cb(info)),
  };
  return terminal;
};

vi.mock('../../src/terminal.js', () => ({
  createTerminal: vi.fn(() => {
    mockTerminal = createMockTerminal();
    return mockTerminal;
  }),
}));

// Mock child_process
vi.mock('child_process', () => ({
  // tmux is invoked through execFile with an argument array (never a shell string)
  execFile: vi.fn((_file, _args, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    if (callback) callback(null, { stdout: '', stderr: '' });
  }),
  execFileSync: vi.fn(() => ''),
  execSync: vi.fn(() => ''),
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    proc.pid = 12345;
    return proc;
  }),
}));

// Mock node-pty
vi.mock('@homebridge/node-pty-prebuilt-multiarch', () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as any;
    proc.write = vi.fn();
    proc.resize = vi.fn();
    proc.kill = vi.fn();
    proc.onData = (cb: any) => proc.on('data', cb);
    proc.onExit = (cb: any) => proc.on('exit', cb);
    return proc;
  }),
}));

// Mock editor
vi.mock('../../src/editor.js', () => ({
  initEditor: vi.fn(),
  getOrStartEditor: vi.fn(),
  stopEditor: vi.fn(),
  getEditorStatus: vi.fn().mockReturnValue({ running: false }),
  getAllEditors: vi.fn().mockReturnValue([]),
  updateEditorActivity: vi.fn(),
  shutdownAllEditors: vi.fn(),
}));

describe('WebSocket Terminal', () => {
  let server: any;
  let port: number;

  beforeAll(async () => {
    const { createServer } = await import('../../src/server.js');
    server = await createServer();

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(() => {
    if (server?.close) {
      server.close();
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockTerminal = null;
  });

  const connectWS = (project: string, session?: string): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      const url = `ws://localhost:${port}/terminal?project=${project}${session ? `&session=${session}` : ''}`;
      const ws = new WebSocket(url);

      ws.on('open', () => resolve(ws));
      ws.on('error', reject);

      // Timeout after 5 seconds
      setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });
  };

  describe('Connection', () => {
    it('connects successfully with allowed project', async () => {
      const ws = await connectWS('allowed-project');
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('rejects connection for non-whitelisted project', async () => {
      const closeCode = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}/terminal?project=not-allowed`);
        const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);
        ws.on('close', (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
        ws.on('error', () => {
          // Ignore errors, wait for close
        });
      });

      expect(closeCode).toBe(1008); // Policy Violation
    });

    it('rejects connection without project', async () => {
      const closeCode = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}/terminal`);
        const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);
        ws.on('close', (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
        ws.on('error', () => {
          // Ignore errors, wait for close
        });
      });

      expect(closeCode).toBe(1008); // Policy Violation
    });

    it('accepts custom session name', async () => {
      const ws = await connectWS('allowed-project', 'custom-session-42');
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it.each([
      ['shell metacharacters', 'x";id;"'],
      ['command substitution', 'a$(touch /tmp/pwned)'],
      ['path traversal', '../../etc/cron.d/evil'],
      ['a newline', 'a\nmalicious'],
    ])('rejects a session name containing %s before any terminal is created', async (_l, name) => {
      const { createTerminal } = await import('../../src/terminal.js');

      const closeCode = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://localhost:${port}/terminal?project=allowed-project&create=true&session=${encodeURIComponent(name)}`
        );
        const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);
        ws.on('close', (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
        ws.on('error', () => {
          // Ignore errors, wait for close
        });
      });

      expect(closeCode).toBe(1008); // Policy Violation
      expect(vi.mocked(createTerminal)).not.toHaveBeenCalled();
      expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    });
  });

  describe('Origin allowlist', () => {
    const upgradeResult = (path: string, origin: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}${path}`, { origin });
        const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);
        ws.on('open', () => {
          clearTimeout(timeout);
          ws.close();
          resolve('open');
        });
        ws.on('error', (err) => {
          clearTimeout(timeout);
          resolve(err.message);
        });
      });

    it.each(['/terminal?project=allowed-project&create=true', '/sessions'])(
      'refuses a WebSocket upgrade for %s from a page that is not the dashboard',
      async (path) => {
        const { createTerminal } = await import('../../src/terminal.js');

        const result = await upgradeResult(path, 'https://evil.example.com');

        expect(result).toContain('403');
        expect(vi.mocked(createTerminal)).not.toHaveBeenCalled();
      }
    );

    it('accepts a WebSocket upgrade from the dashboard origin', async () => {
      expect(await upgradeResult('/sessions', 'https://247.quivr.com')).toBe('open');
    });
  });

  describe('Message handling', () => {
    it('responds to ping with pong', async () => {
      const ws = await connectWS('allowed-project');

      const response = await new Promise<any>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'pong') {
            resolve(msg);
          }
        });
        ws.send(JSON.stringify({ type: 'ping' }));
      });

      expect(response.type).toBe('pong');
      ws.close();
    });

    it('forwards input to terminal', async () => {
      const ws = await connectWS('allowed-project');

      // Wait for terminal to be created
      await new Promise((r) => setTimeout(r, 100));

      ws.send(JSON.stringify({ type: 'input', data: 'ls -la\n' }));

      // Wait for message processing
      await new Promise((r) => setTimeout(r, 100));

      expect(mockTerminal.write).toHaveBeenCalledWith('ls -la\n');
      ws.close();
    });

    it('forwards resize to terminal', async () => {
      const ws = await connectWS('allowed-project');

      // Wait for terminal to be created
      await new Promise((r) => setTimeout(r, 100));

      ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));

      // Wait for message processing
      await new Promise((r) => setTimeout(r, 100));

      expect(mockTerminal.resize).toHaveBeenCalledWith(120, 40);
      ws.close();
    });

    it('handles start-claude message', async () => {
      const ws = await connectWS('allowed-project');

      // Wait for terminal to be created
      await new Promise((r) => setTimeout(r, 100));

      ws.send(JSON.stringify({ type: 'start-claude' }));

      // Wait for message processing
      await new Promise((r) => setTimeout(r, 100));

      // Should write claude command to terminal
      expect(mockTerminal.write).toHaveBeenCalled();
      ws.close();
    });

    it('handles request-history message', async () => {
      const ws = await connectWS('allowed-project');

      // Wait for terminal to be created
      await new Promise((r) => setTimeout(r, 100));

      const historyResponse = await new Promise<any>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'history') {
            resolve(msg);
          }
        });
        ws.send(JSON.stringify({ type: 'request-history', lines: 100 }));
      });

      expect(historyResponse.type).toBe('history');
      expect(historyResponse.data).toBeDefined();
      ws.close();
    });

    it('ignores invalid JSON messages', async () => {
      const ws = await connectWS('allowed-project');

      // This should not crash the server
      ws.send('not json');
      ws.send('{invalid}');

      // Wait for error handling
      await new Promise((r) => setTimeout(r, 100));

      // Connection should still be open
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('ignores unknown message types', async () => {
      const ws = await connectWS('allowed-project');

      ws.send(JSON.stringify({ type: 'unknown-type' }));

      // Wait for message processing
      await new Promise((r) => setTimeout(r, 100));

      // Connection should still be open
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });
  });

  describe('Terminal output', () => {
    it('forwards terminal output to client', async () => {
      const ws = await connectWS('allowed-project');

      // Wait for terminal to be created
      await new Promise((r) => setTimeout(r, 100));

      const output = await new Promise<Buffer>((resolve) => {
        ws.on('message', (data) => {
          // Skip JSON messages (like history)
          if (data instanceof Buffer && !data.toString().startsWith('{')) {
            resolve(data);
          }
        });

        // Simulate terminal output
        mockTerminal.emitData('Hello, World!');
      });

      expect(output.toString()).toBe('Hello, World!');
      ws.close();
    });
  });

  describe('Connection cleanup', () => {
    it('detaches terminal on close', async () => {
      const ws = await connectWS('allowed-project');

      // Wait for terminal to be created
      await new Promise((r) => setTimeout(r, 100));

      ws.close();

      // Wait for close handling
      await new Promise((r) => setTimeout(r, 100));

      expect(mockTerminal.detach).toHaveBeenCalled();
    });
  });

  describe('Sessions WebSocket', () => {
    // The server sends 'version-info' synchronously on connect and 'sessions-list'
    // shortly after (once the tmux lookup settles), so the message listener must be
    // attached at socket-creation time - attaching it only after 'open' resolves is
    // racy and can miss the first frame.
    const connectSessionsAndCollect = (): Promise<{ ws: WebSocket; messages: any[] }> => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}/sessions`);
        const messages: any[] = [];
        ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
        ws.on('open', () => resolve({ ws, messages }));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('Connection timeout')), 5000);
      });
    };

    const waitForMessageType = async (messages: any[], type: string): Promise<any> => {
      for (let i = 0; i < 50; i++) {
        const found = messages.find((m) => m.type === type);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Timed out waiting for message type "${type}"`);
    };

    it('reports an empty session list without logging an error when tmux has no server running', async () => {
      // tmux exits with code 1 and no output when its server isn't running yet -
      // this is the normal state for a fresh install and must not be treated as an error.
      vi.mocked(execFile).mockImplementationOnce((_file: any, _args: any, opts: any, cb: any) => {
        const callback = typeof opts === 'function' ? opts : cb;
        const err = Object.assign(new Error('Command failed'), { code: 1, stdout: '', stderr: '' });
        callback(err);
        return {} as any;
      });

      const debugSpy = vi.spyOn(logger.session, 'debug').mockImplementation(() => logger.session);
      const errorSpy = vi.spyOn(logger.session, 'error').mockImplementation(() => logger.session);

      const { ws, messages } = await connectSessionsAndCollect();
      const sessionsMessage = await waitForMessageType(messages, 'sessions-list');

      expect(sessionsMessage).toEqual({ type: 'sessions-list', sessions: [] });
      expect(errorSpy).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalled();

      ws.close();
      debugSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('logs an error for a genuine tmux failure', async () => {
      vi.mocked(execFile).mockImplementationOnce((_file: any, _args: any, opts: any, cb: any) => {
        const callback = typeof opts === 'function' ? opts : cb;
        const err = Object.assign(new Error('tmux: command not found'), { code: 127 });
        callback(err);
        return {} as any;
      });

      const errorSpy = vi.spyOn(logger.session, 'error').mockImplementation(() => logger.session);

      const { ws, messages } = await connectSessionsAndCollect();
      await waitForMessageType(messages, 'sessions-list');

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.anything() }),
        'Failed to get initial sessions'
      );

      ws.close();
      errorSpy.mockRestore();
    });

    it('parses the tmux session list and enriches each entry with DB status data', async () => {
      // tmux reports "<session_name>|<session_created>" per line; the session name's
      // "project--suffix" prefix becomes the project, and created (seconds) becomes
      // createdAt (ms). DB rows add status/activity when present and are omitted otherwise.
      vi.mocked(execFile).mockImplementationOnce((_file: any, _args: any, opts: any, cb: any) => {
        const callback = typeof opts === 'function' ? opts : cb;
        callback(null, {
          stdout: 'proj1--aaa|1700000000\nproj2--bbb|1700000100\n',
          stderr: '',
        });
        return {} as any;
      });

      vi.mocked(getSession).mockImplementation((name: string) =>
        name === 'proj1--aaa'
          ? {
              id: 1,
              name: 'proj1--aaa',
              project: 'proj1',
              last_event: 'Stop',
              last_activity: 1700000500000,
              archived_at: null,
              created_at: 1700000000000,
              updated_at: 1700000500000,
              status: 'idle',
              status_source: 'hook',
              attention_reason: null,
              last_status_change: 1700000400000,
            }
          : null
      );

      try {
        const { ws, messages } = await connectSessionsAndCollect();
        const sessionsMessage = await waitForMessageType(messages, 'sessions-list');

        expect(sessionsMessage.sessions).toEqual([
          {
            // enriched from the DB row (attentionReason is null -> dropped during JSON serialization)
            name: 'proj1--aaa',
            project: 'proj1',
            createdAt: 1700000000000,
            lastActivity: 1700000500000,
            lastEvent: 'Stop',
            status: 'idle',
            statusSource: 'hook',
            lastStatusChange: 1700000400000,
          },
          {
            // no DB row -> only the fields derivable from tmux are present
            name: 'proj2--bbb',
            project: 'proj2',
            createdAt: 1700000100000,
          },
        ]);

        ws.close();
      } finally {
        vi.mocked(getSession).mockReturnValue(null);
      }
    });
  });
});
