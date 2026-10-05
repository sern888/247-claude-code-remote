import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { EventEmitter } from 'events';
import express from 'express';

// Mock config
const mockConfig = {
  machine: { id: 'test-machine', name: 'Test Machine' },
  projects: {
    basePath: '/tmp/test-projects',
    whitelist: ['allowed-project', 'another-project'],
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

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readdir: vi.fn().mockResolvedValue([
    { name: 'allowed-project', isDirectory: () => true },
    { name: 'another-project', isDirectory: () => true },
    { name: 'unlisted-project', isDirectory: () => true },
    { name: '.hidden', isDirectory: () => true },
    { name: 'file.txt', isDirectory: () => false },
  ]),
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
  rm: vi.fn().mockResolvedValue(undefined),
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

// Mock terminal
vi.mock('../../src/terminal.js', () => ({
  createTerminal: vi.fn(() => ({
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
    detach: vi.fn(),
    captureHistory: vi.fn().mockResolvedValue(''),
    isExistingSession: vi.fn().mockReturnValue(false),
  })),
}));

describe('Agent REST API', () => {
  let app: express.Express;
  let server: any;

  beforeAll(async () => {
    const { createServer } = await import('../../src/server.js');
    server = await createServer();
    app = server._events?.request || server;
  });

  afterAll(() => {
    if (server?.close) {
      server.close();
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/projects', () => {
    it('returns the whitelist', async () => {
      const res = await request(server).get('/api/projects');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(['allowed-project', 'another-project']);
    });
  });

  describe('GET /api/folders', () => {
    it('returns non-hidden directories', async () => {
      const res = await request(server).get('/api/folders');

      expect(res.status).toBe(200);
      expect(res.body).toContain('allowed-project');
      expect(res.body).toContain('another-project');
      expect(res.body).toContain('unlisted-project');
      expect(res.body).not.toContain('.hidden');
      expect(res.body).not.toContain('file.txt');
    });

    it('sorts folders alphabetically', async () => {
      const res = await request(server).get('/api/folders');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([...res.body].sort());
    });
  });

  describe('GET /api/sessions', () => {
    it('returns empty array when no sessions', async () => {
      // tmux exits with code 1 when its server is not running (no sessions yet)
      const { execFile } = await import('child_process');
      vi.mocked(execFile).mockImplementation((_file: any, _args: any, opts: any, cb: any) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (callback) callback(Object.assign(new Error('no server running'), { code: 1 }));
        return null as any;
      });

      const res = await request(server).get('/api/sessions');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('reports a failure instead of an empty list when tmux cannot be run', async () => {
      const { execFile } = await import('child_process');
      vi.mocked(execFile).mockImplementation((_file: any, _args: any, opts: any, cb: any) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (callback) callback(Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }));
        return null as any;
      });

      const res = await request(server).get('/api/sessions');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to list sessions' });
    });
  });

  describe('GET /api/sessions/:sessionName/preview', () => {
    it('validates session name format', async () => {
      const res = await request(server).get('/api/sessions/invalid;rm -rf/preview');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid session name');
    });

    it('accepts valid session name', async () => {
      const { execFile } = await import('child_process');
      vi.mocked(execFile).mockImplementation((_file: any, _args: any, opts: any, cb: any) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (callback) callback(null, { stdout: 'line1\nline2\n', stderr: '' });
        return null as any;
      });

      const res = await request(server).get('/api/sessions/project--valid-session-42/preview');

      // Should not be a 400 error
      expect(res.status).not.toBe(400);
    });
  });

  describe('DELETE /api/sessions/:sessionName', () => {
    it('validates session name format', async () => {
      const res = await request(server).delete('/api/sessions/invalid;rm -rf/');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid session name');
    });
  });

  describe('Origin allowlist', () => {
    it('rejects requests from a browser origin that is not the dashboard', async () => {
      const res = await request(server)
        .get('/api/projects')
        .set('Origin', 'https://evil.example.com');

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Origin not allowed' });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('rejects state-changing requests from an unknown origin before they run', async () => {
      const { execFile } = await import('child_process');

      const res = await request(server)
        .post('/api/sessions/proj--a/input')
        .set('Origin', 'http://localhost:9999')
        .send({ text: 'rm -rf ~' });

      expect(res.status).toBe(403);
      expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    });

    it('allows the hosted dashboard and answers its CORS check', async () => {
      const res = await request(server).get('/api/projects').set('Origin', 'https://247.quivr.com');

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://247.quivr.com');
    });

    it('allows the dashboard configured in config.dashboard.apiUrl', async () => {
      const res = await request(server).get('/api/projects').set('Origin', 'http://localhost:3001');

      expect(res.status).toBe(200);
    });

    it('allows clients that send no Origin header (CLI, hook script)', async () => {
      const res = await request(server).get('/health');

      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/sessions/:sessionName/input', () => {
    it('requires text', async () => {
      const res = await request(server).post('/api/sessions/proj--a/input').send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'Text is required' });
    });

    it('answers 404 without typing anything when the session does not exist', async () => {
      const { execFile } = await import('child_process');
      vi.mocked(execFile).mockImplementation((_file: any, _args: any, opts: any, cb: any) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (callback) callback(Object.assign(new Error("can't find session"), { code: 1 }));
        return null as any;
      });

      const res = await request(server)
        .post('/api/sessions/proj--a/input')
        .send({ text: '$(touch /tmp/pwned)' });

      expect(res.status).toBe(404);
      const sentKeys = vi
        .mocked(execFile)
        .mock.calls.filter(([, args]) => (args as string[])[0] === 'send-keys');
      expect(sentKeys).toHaveLength(0);
    });
  });

  describe('POST /api/clone', () => {
    it.each([
      ['an option-like repository name', 'git@host:--config=core.sshCommand=touch pwned'],
      ['a dash-prefixed name', 'https://example.com/user/-oProxyCommand=evil'],
      ['a URL without a repository name', 'https://example.com/user/..'],
    ])('rejects %s without running git', async (_label, url) => {
      const { spawn } = await import('child_process');

      const res = await request(server).post('/api/clone').send({ url });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    });

    it('rejects a non-string url', async () => {
      const res = await request(server)
        .post('/api/clone')
        .send({ url: { evil: true } });

      expect(res.status).toBe(400);
    });
  });
});
