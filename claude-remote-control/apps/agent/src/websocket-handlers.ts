/**
 * WebSocket handlers for terminal connections and sessions subscriptions.
 * Simplified version without status tracking, worktree or execution manager features.
 */

import { existsSync } from 'fs';
import { WebSocket } from 'ws';
import { createTerminal } from './terminal.js';
import type { Terminal } from './terminal.js';
import { config } from './config.js';
import * as sessionsDb from './db/sessions.js';
import type { WSMessageToAgent, WSSessionInfo, WSSessionsMessageFromAgent } from '247-shared';
import { getAgentVersion, needsUpdate } from './version.js';
import { triggerUpdate, isUpdateInProgress } from './updater.js';
import { logger } from './logger.js';
import { getLiveSessions } from './lib/session-list.js';
import { hasSessionSync } from './lib/tmux.js';
import {
  clampHistoryLines,
  expandHome,
  isValidSemver,
  isValidSessionName,
  resolveInsideBase,
  sanitizeSessionNamePart,
} from './lib/validation.js';

// WebSocket close codes
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_INTERNAL_ERROR = 1011;
const CLOSE_NORMAL = 1000;
const CLOSE_SESSION_NOT_FOUND = 4001;

const RECONNECT_HISTORY_LINES = 10000;
const UPDATE_DELAY_MS = 2000;
const MAX_TERMINAL_DIMENSION = 1000;

// Connection tracking
const activeConnections = new Map<string, Set<WebSocket>>();
const sessionsSubscribers = new Set<WebSocket>();

// Generate unique session name
let sessionCounter = 0;
function generateSessionName(project: string): string {
  const timestamp = Date.now().toString(36);
  const counter = (sessionCounter++).toString(36);
  return `${sanitizeSessionNamePart(project)}--${timestamp}${counter}`;
}

function broadcastToSubscribers(message: WSSessionsMessageFromAgent): void {
  const payload = JSON.stringify(message);

  for (const ws of sessionsSubscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

/**
 * Broadcast session removed event to all subscribers
 */
export function broadcastSessionRemoved(sessionName: string): void {
  broadcastToSubscribers({ type: 'session-removed', sessionName });
}

/**
 * Broadcast session archived event to all subscribers
 */
export function broadcastSessionArchived(sessionName: string, session: WSSessionInfo): void {
  broadcastToSubscribers({ type: 'session-archived', sessionName, session });
}

/**
 * Broadcast session status update to all subscribers
 * Called when a hook notifies the agent of a status change
 */
export function broadcastStatusUpdate(session: WSSessionInfo): void {
  logger.session.info(
    { session: session.name, status: session.status, reason: session.attentionReason },
    'Broadcasting status update'
  );
  broadcastToSubscribers({ type: 'status-update', session });
}

/**
 * Broadcast update-pending message to all sessions subscribers
 */
export function broadcastUpdatePending(targetVersion: string, message: string): void {
  broadcastToSubscribers({ type: 'update-pending', targetVersion, message });
}

/**
 * Work out which directory a terminal may start in.
 * An empty project means "terminal at the projects root".
 */
function resolveProjectPath(project: string): string | null {
  const basePath = expandHome(config.projects.basePath);
  if (project === '') {
    return basePath;
  }

  const whitelist = config.projects.whitelist ?? [];
  if (whitelist.length > 0 && !whitelist.includes(project)) {
    return null;
  }
  return resolveInsideBase(basePath, project);
}

function sendHistory(ws: WebSocket, history: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'history', data: history, lines: history.split('\n').length }));
  }
}

function isTerminalDimension(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_TERMINAL_DIMENSION
  );
}

/**
 * Handle individual terminal messages
 */
function handleTerminalMessage(msg: WSMessageToAgent, terminal: Terminal, ws: WebSocket): void {
  switch (msg.type) {
    case 'input':
      if (typeof msg.data === 'string') {
        terminal.write(msg.data);
      }
      break;
    case 'resize':
      if (isTerminalDimension(msg.cols) && isTerminalDimension(msg.rows)) {
        terminal.resize(msg.cols, msg.rows);
      }
      break;
    case 'start-claude':
      terminal.write('claude\r');
      break;
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
    case 'request-history':
      terminal
        .captureHistory(clampHistoryLines(msg.lines, RECONNECT_HISTORY_LINES))
        .then((history) => sendHistory(ws, history))
        .catch((err) => logger.terminal.error({ err }, 'Failed to capture history'));
      break;
  }
}

/**
 * Parse and dispatch one raw message. Message contents are never logged:
 * they are the user's keystrokes.
 */
function dispatchRawMessage(raw: Buffer, terminal: Terminal, ws: WebSocket): void {
  let msg: WSMessageToAgent;
  try {
    msg = JSON.parse(raw.toString());
  } catch (err) {
    logger.terminal.warn({ err }, 'Ignoring malformed terminal message');
    return;
  }

  try {
    handleTerminalMessage(msg, terminal, ws);
  } catch (err) {
    logger.terminal.error({ err, type: msg?.type }, 'Failed to handle terminal message');
  }
}

/**
 * Handle terminal WebSocket connections
 */
export function handleTerminalConnection(ws: WebSocket, url: URL): void {
  // Registered first so a bad frame during setup cannot crash the process
  ws.on('error', (err) => logger.terminal.error({ err }, 'Terminal WebSocket error'));

  const project = url.searchParams.get('project');
  const urlSessionName = url.searchParams.get('session');
  const createFlag = url.searchParams.get('create') === 'true';

  if (project === null) {
    ws.close(CLOSE_POLICY_VIOLATION, 'Project not allowed');
    return;
  }

  const sessionName = urlSessionName || generateSessionName(project || 'root');
  if (!isValidSessionName(sessionName)) {
    ws.close(CLOSE_POLICY_VIOLATION, 'Invalid session name');
    return;
  }

  const projectPath = resolveProjectPath(project);
  if (!projectPath) {
    ws.close(CLOSE_POLICY_VIOLATION, 'Project not allowed');
    return;
  }

  logger.terminal.info({ project, session: sessionName }, 'New terminal connection');

  // Messages can arrive before the terminal exists
  const messageBuffer: Buffer[] = [];
  let terminal: Terminal | null = null;
  let closed = false;

  ws.on('message', (data) => {
    if (!terminal) {
      messageBuffer.push(data as Buffer);
      return;
    }
    dispatchRawMessage(data as Buffer, terminal, ws);
  });

  // Registered before setup so a client that leaves mid-setup does not leak the PTY
  ws.on('close', () => {
    closed = true;
    logger.terminal.info({ session: sessionName }, 'Client disconnected, tmux session preserved');
    terminal?.detach();

    const connections = activeConnections.get(sessionName);
    if (connections) {
      connections.delete(ws);
      if (connections.size === 0) activeConnections.delete(sessionName);
    }
  });

  if (!existsSync(projectPath)) {
    logger.terminal.warn({ projectPath }, 'Project path does not exist');
    ws.close(CLOSE_POLICY_VIOLATION, 'Project path not found');
    return;
  }

  // If session doesn't exist and no create flag, reject the connection
  if (!hasSessionSync(sessionName) && !createFlag) {
    logger.terminal.info({ session: sessionName }, 'Session not found and create flag not set');
    ws.close(CLOSE_SESSION_NOT_FOUND, 'Session not found');
    return;
  }

  let created: Terminal;
  try {
    created = createTerminal(projectPath, sessionName, {});
  } catch (err) {
    logger.terminal.error({ err, session: sessionName }, 'Failed to create terminal');
    ws.close(CLOSE_INTERNAL_ERROR, 'Failed to create terminal');
    return;
  }

  if (closed) {
    created.detach();
    return;
  }
  terminal = created;

  // Track connection
  const connections = activeConnections.get(sessionName) ?? new Set<WebSocket>();
  connections.add(ws);
  activeConnections.set(sessionName, connections);

  if (created.isExistingSession()) {
    created
      .captureHistory(RECONNECT_HISTORY_LINES)
      .then((history) => {
        if (history) sendHistory(ws, history);
      })
      .catch((err) =>
        logger.terminal.error({ err, session: sessionName }, 'Failed to capture history')
      );
  } else {
    // New session - register in DB
    try {
      sessionsDb.upsertSession(sessionName, {
        project,
        lastEvent: 'SessionCreated',
        lastActivity: Date.now(),
      });
    } catch (err) {
      logger.terminal.error({ err, session: sessionName }, 'Failed to persist session');
    }
  }

  // Forward terminal output (never logged: it may contain secrets)
  created.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  created.onExit(({ exitCode }: { exitCode: number }) => {
    logger.terminal.info({ session: sessionName, exitCode }, 'Terminal exited');
    if (ws.readyState === WebSocket.OPEN) ws.close(CLOSE_NORMAL, 'Terminal closed');
  });

  // Process any messages that were buffered during setup
  for (const buffered of messageBuffer) {
    dispatchRawMessage(buffered, created, ws);
  }
  messageBuffer.length = 0;
}

/**
 * Start an auto-update when the dashboard reports a newer version.
 * The version comes from the client, so it must be a plain semver.
 */
function maybeTriggerUpdate(webVersion: string | null | undefined, agentVersion: string): void {
  // Skip auto-update in cloud/Docker environments
  const isCloudAgent = process.env.CLOUD_AGENT === 'true';
  if (!webVersion || isCloudAgent || isUpdateInProgress()) {
    return;
  }
  if (!isValidSemver(webVersion)) {
    logger.main.warn('Ignoring malformed dashboard version');
    return;
  }
  // Only upgrade, never downgrade
  if (!needsUpdate(agentVersion, webVersion)) {
    return;
  }

  logger.main.info({ agentVersion, webVersion }, 'Version mismatch detected');

  // Delay update to allow client connection to stabilize
  setTimeout(() => {
    triggerUpdate(webVersion);
  }, UPDATE_DELAY_MS);
}

async function sendInitialSessions(ws: WebSocket): Promise<void> {
  let sessions: WSSessionInfo[] = [];
  try {
    sessions = await getLiveSessions();
    if (sessions.length === 0) {
      logger.session.debug('No active tmux sessions');
    }
  } catch (err) {
    logger.session.error({ err }, 'Failed to get initial sessions');
  }

  if (ws.readyState === WebSocket.OPEN) {
    const message: WSSessionsMessageFromAgent = { type: 'sessions-list', sessions };
    ws.send(JSON.stringify(message));
  }
}

/**
 * Handle sessions WebSocket connections (real-time session list updates)
 */
export function handleSessionsConnection(ws: WebSocket, url?: URL): void {
  ws.on('error', (err) => {
    logger.session.error({ err }, 'Sessions WebSocket error');
    sessionsSubscribers.delete(ws);
  });

  ws.on('close', () => {
    sessionsSubscribers.delete(ws);
    logger.session.info({ remaining: sessionsSubscribers.size }, 'Subscriber disconnected');
  });

  logger.session.info('New subscriber connected');
  sessionsSubscribers.add(ws);

  const agentVersion = getAgentVersion();

  // Send agent version info to client
  if (ws.readyState === WebSocket.OPEN) {
    const versionMessage: WSSessionsMessageFromAgent = {
      type: 'version-info',
      agentVersion,
    };
    ws.send(JSON.stringify(versionMessage));
  }

  maybeTriggerUpdate(url?.searchParams.get('v'), agentVersion);

  void sendInitialSessions(ws);
}
