import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { EventEmitter } from 'events';

const TEST_TOKEN = 'integration-test-token';

// Config WITH an auth token, so the server enforces authentication.
const mockConfig = {
  machine: { id: 'test-machine', name: 'Test Machine' },
  agent: { authToken: TEST_TOKEN },
  projects: {
    basePath: '/tmp/test-projects',
    whitelist: ['allowed-project'],
  },
};

vi.mock('../../src/config.js', () => ({
  config: mockConfig,
  loadConfig: () => mockConfig,
  default: mockConfig,
}));

vi.mock('fs/promises', () => ({
  readdir: vi.fn().mockResolvedValue([{ name: 'allowed-project', isDirectory: () => true }]),
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn((_file, _args, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    if (callback) callback(null, { stdout: '', stderr: '' });
  }),
  execFileSync: vi.fn(() => ''),
  execSync: vi.fn(() => ''),
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as unknown as {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
      pid: number;
    };
    return proc;
  }),
}));

vi.mock('@homebridge/node-pty-prebuilt-multiarch', () => ({
  spawn: vi.fn(() => new EventEmitter()),
}));

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

describe('Agent authentication enforcement', () => {
  let server: import('http').Server;
  const previousEnvToken = process.env.AGENT_247_AUTH_TOKEN;

  beforeAll(async () => {
    // The env override wins over config in resolveAuthToken, so a value set in
    // the surrounding environment would break these config-token assertions.
    // Pin it to the test token for a deterministic run.
    process.env.AGENT_247_AUTH_TOKEN = TEST_TOKEN;
    const { createServer } = await import('../../src/server.js');
    server = await createServer();
  });

  afterAll(() => {
    server?.close();
    if (previousEnvToken === undefined) {
      delete process.env.AGENT_247_AUTH_TOKEN;
    } else {
      process.env.AGENT_247_AUTH_TOKEN = previousEnvToken;
    }
  });

  describe('protected routes', () => {
    it('rejects a request with no Authorization header', async () => {
      const res = await request(server).get('/api/projects');
      expect(res.status).toBe(401);
    });

    it('rejects a request with a wrong token', async () => {
      const res = await request(server)
        .get('/api/projects')
        .set('Authorization', 'Bearer wrong-token');
      expect(res.status).toBe(401);
    });

    it('accepts a request with the correct bearer token', async () => {
      const res = await request(server)
        .get('/api/projects')
        .set('Authorization', `Bearer ${TEST_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(['allowed-project']);
    });
  });

  describe('public routes (no token required)', () => {
    it('serves /health without a token', async () => {
      const res = await request(server).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('serves /api/pair/info without a token but does NOT leak the authToken', async () => {
      const res = await request(server).get('/api/pair/info');
      expect(res.status).toBe(200);
      // /info is public and unproven, so it must never expose the auth token.
      expect(res.body.authToken).toBeUndefined();
    });
  });

  describe('pairing token exchange', () => {
    it('returns the agent authToken only for a valid pairing token', async () => {
      const info = await request(server).get('/api/pair/info');
      const pairingToken = info.body.token as string;

      const ok = await request(server).post('/api/pair/verify').send({ token: pairingToken });
      expect(ok.status).toBe(200);
      expect(ok.body.valid).toBe(true);
      expect(ok.body.authToken).toBe(TEST_TOKEN);

      const bad = await request(server).post('/api/pair/verify').send({ token: 'not-a-token' });
      expect(bad.status).toBe(401);
    });

    it('returns the agent authToken for a valid 6-digit code', async () => {
      // Issuing pairing info registers this machine's code in the agent.
      const info = await request(server).get('/api/pair/info');
      const code = info.body.code as string;

      const ok = await request(server).get(`/api/pair/code/${code}`);
      expect(ok.status).toBe(200);
      expect(ok.body.authToken).toBe(TEST_TOKEN);

      const bad = await request(server).get('/api/pair/code/000000');
      expect(bad.status).toBe(404);
    });
  });
});
