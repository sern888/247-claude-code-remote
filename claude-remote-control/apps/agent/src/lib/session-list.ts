/**
 * Builds the session list shown by the dashboard: running tmux sessions
 * enriched with what the agent has recorded about them.
 */

import type { WSSessionInfo } from '247-shared';
import * as sessionsDb from '../db/sessions.js';
import { listSessions } from './tmux.js';

// Session names look like "<project>--<suffix>"
const SESSION_NAME_SEPARATOR = '--';

/**
 * Rejects when tmux cannot be queried; resolves to [] when nothing is running.
 */
export async function getLiveSessions(): Promise<WSSessionInfo[]> {
  const tmuxSessions = await listSessions();

  return tmuxSessions.map(({ name, createdAt }) => {
    const dbSession = sessionsDb.getSession(name);

    return {
      name,
      // The name only carries a sanitized copy of the project folder
      project: dbSession?.project ?? name.split(SESSION_NAME_SEPARATOR)[0],
      createdAt,
      lastActivity: dbSession?.last_activity,
      lastEvent: dbSession?.last_event ?? undefined,
      status: dbSession?.status ?? undefined,
      statusSource: dbSession?.status_source ?? undefined,
      attentionReason: dbSession?.attention_reason ?? undefined,
      lastStatusChange: dbSession?.last_status_change ?? undefined,
    };
  });
}
