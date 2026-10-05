/**
 * Main server entry point - Express HTTP server with WebSocket support.
 * Routes and handlers are split into separate modules for maintainability.
 */

import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer as createHttpServer } from 'http';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { initDatabase, closeDatabase } from './db/index.js';
import * as sessionsDb from './db/sessions.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { buildAllowedOrigins, isOriginAllowed } from './lib/origin.js';
import {
  resolveAuthToken,
  isAuthorized,
  extractBearerToken,
  extractWebSocketToken,
  WS_TOKEN_PROTOCOL_PREFIX,
} from './lib/auth.js';
import { listSessionNamesSync } from './lib/tmux.js';

// Routes
import {
  createProjectRoutes,
  createSessionRoutes,
  createPairRoutes,
  createHooksRoutes,
} from './routes/index.js';

// WebSocket
import { handleTerminalConnection, handleSessionsConnection } from './websocket-handlers.js';

// req.url is only a path; the base just lets URL parse it and must not come
// from the Host header (a malformed one would throw).
const UPGRADE_URL_BASE = 'http://localhost';

function rejectUpgrade(socket: Duplex, statusLine: string): void {
  socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export async function createServer() {
  const allowedOrigins = buildAllowedOrigins({
    dashboardUrl: config.dashboard?.apiUrl,
    configured: config.agent?.allowedOrigins,
    envValue: process.env.AGENT_247_ALLOWED_ORIGINS,
  });

  // The shared secret that gates the shell surface. When unset the agent runs
  // without authentication, which keeps pre-token installs working but leaves
  // anyone who can reach the port able to open a terminal.
  const expectedToken = resolveAuthToken(config.agent?.authToken, process.env.AGENT_247_AUTH_TOKEN);
  if (!expectedToken) {
    logger.server.warn(
      'No agent.authToken configured: running WITHOUT authentication. ' +
        'Anyone who can reach this agent can open a terminal. Run `247 init` to add a token.'
    );
  }

  // Pairing and health must stay reachable without a token: pairing is how the
  // dashboard obtains the token in the first place, and health is for probes.
  const isPublicPath = (path: string): boolean =>
    path === '/health' ||
    path === '/pair' ||
    path.startsWith('/pair/') ||
    path === '/api/pair' ||
    path.startsWith('/api/pair/');

  const app = express();

  // The agent hands out a shell: a web page the user merely visits must not
  // be able to call it. Requests without an Origin (CLI, hooks) pass through.
  app.use((req, res, next) => {
    if (!isOriginAllowed(req.headers.origin, allowedOrigins)) {
      logger.server.warn({ origin: req.headers.origin, path: req.path }, 'Rejected origin');
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
    next();
  });
  app.use(
    cors({
      origin: (origin, callback) => callback(null, isOriginAllowed(origin, allowedOrigins)),
    })
  );

  // Require the bearer token on everything except health, pairing and CORS
  // preflight (which carries no Authorization header). A no-op when auth is
  // disabled (expectedToken undefined).
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS' || isPublicPath(req.path)) {
      next();
      return;
    }
    if (!isAuthorized(extractBearerToken(req.headers.authorization), expectedToken)) {
      logger.server.warn({ path: req.path }, 'Rejected unauthenticated request');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  app.use(express.json());

  const server = createHttpServer(app);
  // Echo back the token-bearing subprotocol so the browser's WebSocket
  // handshake completes (a browser that offered a subprotocol expects the
  // server to confirm one). Other offered subprotocols are ignored.
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => {
      for (const protocol of protocols) {
        if (protocol.startsWith(WS_TOKEN_PROTOCOL_PREFIX)) {
          return protocol;
        }
      }
      return false;
    },
  });

  // Initialize SQLite database
  initDatabase();

  // Reconcile sessions with active tmux sessions. When tmux cannot be queried
  // we know nothing about what is running, so nothing may be cleaned up.
  const activeTmuxSessions = listSessionNamesSync();
  if (activeTmuxSessions) {
    sessionsDb.reconcileWithTmux(activeTmuxSessions);
  } else {
    logger.server.warn('Could not query tmux, skipping session reconciliation');
  }

  // Load existing sessions
  const dbSessions = sessionsDb.getAllSessions();
  logger.db.info({ count: dbSessions.length }, 'Loaded sessions from database');

  // Health check endpoint for container orchestration
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // Mount API routes
  app.use('/api', createProjectRoutes());
  app.use('/api/sessions', createSessionRoutes());

  // Mount pairing routes (both at /pair and /api/pair for flexibility)
  app.use('/pair', createPairRoutes());
  app.use('/api/pair', createPairRoutes());

  // Mount hooks routes for Claude Code hook notifications
  app.use('/api/hooks', createHooksRoutes());

  // Handle WebSocket upgrades
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      if (!isOriginAllowed(req.headers.origin, allowedOrigins)) {
        logger.server.warn({ origin: req.headers.origin }, 'Rejected WebSocket origin');
        rejectUpgrade(socket, '403 Forbidden');
        return;
      }

      const wsToken = extractWebSocketToken(req.headers['sec-websocket-protocol']);
      if (!isAuthorized(wsToken, expectedToken)) {
        logger.server.warn('Rejected unauthenticated WebSocket upgrade');
        rejectUpgrade(socket, '401 Unauthorized');
        return;
      }

      const url = new URL(req.url ?? '/', UPGRADE_URL_BASE);

      if (url.pathname === '/terminal') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          handleTerminalConnection(ws, url);
        });
        return;
      }

      if (url.pathname === '/sessions') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          handleSessionsConnection(ws, url);
        });
        return;
      }

      socket.destroy();
    } catch (err) {
      logger.server.warn({ err }, 'Failed to handle WebSocket upgrade');
      socket.destroy();
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.server.info('Shutting down');
    closeDatabase();
    server.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
}
