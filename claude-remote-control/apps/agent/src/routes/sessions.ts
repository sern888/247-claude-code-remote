/**
 * Session API routes: list, preview, kill, archive tmux sessions.
 * Simplified version without spawn, worktree, push, or PR features.
 */

import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { WSSessionInfo } from '247-shared';
import * as sessionsDb from '../db/sessions.js';
import {
  broadcastSessionRemoved,
  broadcastSessionArchived,
  broadcastStatusUpdate,
} from '../websocket-handlers.js';
import { logger } from '../logger.js';
import { getLiveSessions } from '../lib/session-list.js';
import * as tmux from '../lib/tmux.js';
import { clampHistoryLines, isValidSessionName } from '../lib/validation.js';

const DEFAULT_OUTPUT_LINES = 1000;
const PREVIEW_CAPTURE_LINES = 20;
const PREVIEW_VISIBLE_LINES = 15;
const PREVIEW_TRAILING_LINES = 4;
const MAX_INPUT_LENGTH = 100_000;

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1B\[[0-9;]*[a-zA-Z]/g;

/**
 * Session names end up as tmux targets, so every route taking one rejects
 * anything but word characters and dashes before doing any work.
 */
const requireValidSessionName: RequestHandler = (req, res, next) => {
  if (!isValidSessionName(req.params.sessionName)) {
    res.status(400).json({ error: 'Invalid session name' });
    return;
  }
  next();
};

export function createSessionRoutes(): Router {
  const router = Router();

  // Get session output (terminal scrollback)
  router.get('/:sessionName/output', requireValidSessionName, async (req, res) => {
    const { sessionName } = req.params;
    const lines = clampHistoryLines(req.query.lines, DEFAULT_OUTPUT_LINES);
    const format = (req.query.format as string) || 'plain';

    try {
      const captured = await tmux.capturePane(sessionName, lines);
      // Strip ANSI codes if plain format requested
      const output = format === 'plain' ? captured.replace(ANSI_ESCAPE_PATTERN, '') : captured;
      const outputLines = output.split('\n');

      res.json({
        sessionName,
        output,
        totalLines: outputLines.length,
        returnedLines: outputLines.length,
        isRunning: await tmux.hasSession(sessionName),
        capturedAt: Date.now(),
        source: 'live' as const,
      });
    } catch {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // Send input to a session
  router.post('/:sessionName/input', requireValidSessionName, async (req, res) => {
    const { sessionName } = req.params;
    const { text, sendEnter = true } = (req.body ?? {}) as {
      text?: unknown;
      sendEnter?: unknown;
    };

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ success: false, error: 'Text is required' });
    }
    if (text.length > MAX_INPUT_LENGTH) {
      return res.status(413).json({ success: false, error: 'Text is too long' });
    }

    if (!(await tmux.hasSession(sessionName))) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    try {
      await tmux.sendKeys(sessionName, text, sendEnter !== false);
    } catch (err) {
      logger.session.error({ err, session: sessionName }, 'Failed to send input');
      return res.status(500).json({ success: false, error: 'Failed to send input' });
    }

    try {
      sessionsDb.upsertSession(sessionName, { lastEvent: 'Input sent' });
    } catch (err) {
      // The keys were delivered; a bookkeeping failure must not report otherwise
      logger.session.error({ err, session: sessionName }, 'Failed to record input activity');
    }

    res.json({
      success: true,
      sessionName,
      bytesSent: text.length,
    });
  });

  // Enhanced sessions endpoint with detailed info
  router.get('/', async (_req, res) => {
    try {
      res.json(await getLiveSessions());
    } catch (err) {
      logger.session.error({ err }, 'Failed to list sessions');
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  // Get archived sessions
  router.get('/archived', (_req, res) => {
    const archivedSessions = sessionsDb.getArchivedSessions();

    const sessions: WSSessionInfo[] = archivedSessions.map((session) => ({
      name: session.name,
      project: session.project,
      createdAt: session.created_at,
      lastEvent: session.last_event ?? undefined,
      archivedAt: session.archived_at ?? undefined,
    }));

    res.json(sessions);
  });

  // Get single session info by name
  router.get('/:sessionName/status', requireValidSessionName, (req, res) => {
    const { sessionName } = req.params;
    const dbSession = sessionsDb.getSession(sessionName);

    if (!dbSession) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const sessionInfo: WSSessionInfo = {
      name: sessionName,
      project: dbSession.project,
      createdAt: dbSession.created_at,
      lastEvent: dbSession.last_event ?? undefined,
      lastActivity: dbSession.last_activity,
      archivedAt: dbSession.archived_at ?? undefined,
      status: dbSession.status ?? undefined,
      statusSource: dbSession.status_source ?? undefined,
      attentionReason: dbSession.attention_reason ?? undefined,
      lastStatusChange: dbSession.last_status_change ?? undefined,
    };

    res.json(sessionInfo);
  });

  // Acknowledge session - reset needs_attention status
  router.post('/:sessionName/acknowledge', requireValidSessionName, (req, res) => {
    const { sessionName } = req.params;

    const session = sessionsDb.getSession(sessionName);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Only reset if currently needs_attention
    if (session.status === 'needs_attention') {
      const updatedSession = sessionsDb.upsertSession(sessionName, {
        status: 'working',
        attentionReason: null,
      });

      // Broadcast status change to all WebSocket clients
      broadcastStatusUpdate({
        name: sessionName,
        project: updatedSession.project,
        status: 'working',
        attentionReason: undefined,
        statusSource: 'hook',
        createdAt: updatedSession.created_at,
        lastActivity: updatedSession.last_activity,
      });
    }

    res.json({ success: true });
  });

  // Get terminal preview (last N lines from tmux pane)
  router.get('/:sessionName/preview', requireValidSessionName, async (req, res) => {
    const { sessionName } = req.params;

    try {
      const stdout = await tmux.capturePane(sessionName, PREVIEW_CAPTURE_LINES, {
        joinLines: false,
      });

      // Drop blank lines except near the bottom, where they are real spacing
      const allLines = stdout.split('\n');
      const firstTrailingIndex = allLines.length - PREVIEW_TRAILING_LINES;
      const lines = allLines
        .map((line, index) => ({ line, index }))
        .slice(-(PREVIEW_VISIBLE_LINES + 1), -1)
        .filter(({ line, index }) => line.trim() !== '' || index >= firstTrailingIndex)
        .map(({ line }) => line);

      res.json({
        lines: lines.length > 0 ? lines : ['(empty terminal)'],
        timestamp: Date.now(),
      });
    } catch {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // Kill a tmux session
  router.delete('/:sessionName', requireValidSessionName, async (req, res) => {
    const { sessionName } = req.params;

    let killed = true;
    try {
      await tmux.killSession(sessionName);
    } catch {
      killed = false;
    }

    if (!killed && (await tmux.hasSession(sessionName))) {
      logger.session.error({ session: sessionName }, 'Failed to kill tmux session');
      return res.status(500).json({ error: 'Failed to kill session' });
    }

    // tmux may already be gone while the agent still remembers the session
    let removedRecord = false;
    try {
      removedRecord = sessionsDb.deleteSession(sessionName);
    } catch (err) {
      logger.session.error({ err, session: sessionName }, 'Failed to delete session record');
      return res.status(500).json({ error: 'Failed to delete session' });
    }

    if (!killed && !removedRecord) {
      return res.status(404).json({ error: 'Session not found or already killed' });
    }

    broadcastSessionRemoved(sessionName);
    res.json({ success: true, message: `Session ${sessionName} killed` });
  });

  // Archive a session (mark as done and keep in history)
  router.post('/:sessionName/archive', requireValidSessionName, async (req, res) => {
    const { sessionName } = req.params;

    if (!sessionsDb.getSession(sessionName)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Stop the session first: marking it archived while it keeps running
    // would leave a live terminal that the dashboard no longer shows.
    try {
      await tmux.killSession(sessionName);
    } catch {
      if (await tmux.hasSession(sessionName)) {
        logger.session.error({ session: sessionName }, 'Failed to kill tmux session for archive');
        return res.status(500).json({ error: 'Failed to stop session' });
      }
    }

    let archivedSession: ReturnType<typeof sessionsDb.archiveSession>;
    try {
      archivedSession = sessionsDb.archiveSession(sessionName);
    } catch (err) {
      logger.session.error({ err, session: sessionName }, 'Failed to archive session');
      return res.status(500).json({ error: 'Failed to archive session' });
    }
    if (!archivedSession) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const archivedInfo: WSSessionInfo = {
      name: sessionName,
      project: archivedSession.project,
      createdAt: archivedSession.created_at,
      lastEvent: archivedSession.last_event ?? undefined,
      archivedAt: archivedSession.archived_at ?? undefined,
    };

    broadcastSessionArchived(sessionName, archivedInfo);

    res.json({
      success: true,
      message: `Session ${sessionName} archived`,
      session: archivedInfo,
    });
  });

  return router;
}
