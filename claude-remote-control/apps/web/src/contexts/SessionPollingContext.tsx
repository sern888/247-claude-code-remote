'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { SessionInfo, SessionWithMachine } from '@/lib/types';
import { buildWebSocketUrl, buildApiUrl } from '@/lib/utils';
import { authHeaders, wsSubprotocols } from '@/lib/agent-auth';
import { wsLogger, pollingLogger, archivedLogger } from '@/lib/logger';
import type { WSSessionInfo, WSSessionsMessageFromAgent } from '247-shared';

export interface Machine {
  id: string;
  name: string;
  status: string;
  config?: {
    projects: string[];
    agentUrl?: string;
    authToken?: string;
  };
}

interface MachineSessionData {
  machineId: string;
  machineName: string;
  agentUrl: string;
  sessions: SessionInfo[];
  lastFetch: number;
  error: string | null;
  wsConnected: boolean;
}

interface ArchivedSessionData {
  machineId: string;
  machineName: string;
  agentUrl: string;
  sessions: SessionInfo[];
}

type SessionsByMachine = Map<string, MachineSessionData>;
type ArchivedByMachine = Map<string, ArchivedSessionData>;
type NeedsAttentionCallback = (sessionName: string) => void;

interface SessionPollingContextValue {
  sessionsByMachine: SessionsByMachine;
  machines: Machine[];
  getSessionsForMachine: (machineId: string) => SessionInfo[];
  getAllSessions: () => SessionWithMachine[];
  getArchivedSessions: () => SessionWithMachine[];
  getSession: (machineId: string, sessionName: string) => SessionInfo | null;
  refreshMachine: (machineId: string) => Promise<void>;
  setMachines: (machines: Machine[]) => void;
  isLoading: (machineId: string) => boolean;
  getError: (machineId: string) => string | null;
  isWsConnected: (machineId: string) => boolean;
  /**
   * Register a callback for when a session changes to needs_attention.
   * Used for sound notifications.
   */
  setOnNeedsAttention: (callback: NeedsAttentionCallback | undefined) => void;
}

/** Outcome of one HTTP poll: either a session list or an error message. */
type PollResult =
  | { machine: Machine; sessions: SessionInfo[]; error: null }
  | { machine: Machine; sessions: null; error: string };

const SessionPollingContext = createContext<SessionPollingContextValue | null>(null);

const DEFAULT_AGENT_URL = 'localhost:4678';
const FALLBACK_POLLING_INTERVAL = 30000; // Fallback HTTP poll every 30s (when WS connected)
const FETCH_TIMEOUT = 5000;
const WS_RECONNECT_BASE_DELAY = 1000;
const WS_RECONNECT_MAX_DELAY = 30000;
const WS_RECONNECT_STAGGER_DELAY = 1000; // Extra delay per reconnection already in flight
const MAX_SESSIONS_PER_MACHINE = 50; // Limit sessions per machine (FIFO rotation)
const MAX_ARCHIVED_PER_MACHINE = 100; // Limit archived sessions per machine
const MAX_CONCURRENT_RECONNECTIONS = 3; // Limit concurrent WebSocket reconnections
const NO_SESSIONS: SessionInfo[] = [];

// ═══════════════════════════════════════════════════════════════════════════
// Pure helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Limits sessions array to maxCount using FIFO rotation.
 * Keeps the most recent sessions based on lastStatusChange or creation order.
 */
function limitSessions(sessions: SessionInfo[], maxCount: number): SessionInfo[] {
  if (sessions.length <= maxCount) return sessions;
  // Sort by lastStatusChange descending (most recent first), keep newest
  const sorted = [...sessions].sort((a, b) => {
    const aTime = a.lastStatusChange ? new Date(a.lastStatusChange).getTime() : 0;
    const bTime = b.lastStatusChange ? new Date(b.lastStatusChange).getTime() : 0;
    return bTime - aTime;
  });
  return sorted.slice(0, maxCount);
}

function agentUrlOf(machine: Machine): string {
  return machine.config?.agentUrl || DEFAULT_AGENT_URL;
}

function authTokenOf(machine: Machine): string | undefined {
  return machine.config?.authToken;
}

function isOnline(machine: Machine): boolean {
  return machine.status === 'online';
}

/** What a socket was opened for. When it changes, that one socket is replaced. */
function connectionKeyOf(machine: Machine): string {
  return `${agentUrlOf(machine)}\n${machine.name}`;
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'AbortError';
}

function parseSessionsMessage(data: unknown): WSSessionsMessageFromAgent | null {
  try {
    const parsed: unknown = JSON.parse(String(data));
    if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) return null;
    return parsed as WSSessionsMessageFromAgent;
  } catch (err) {
    wsLogger.error('Failed to parse message', err);
    return null;
  }
}

/** Drops every entry whose machine id is no longer known. Returns the same map when nothing changed. */
function pruneToIds<V>(map: Map<string, V>, ids: ReadonlySet<string>): Map<string, V> {
  const kept = [...map].filter(([id]) => ids.has(id));
  return kept.length === map.size ? map : new Map(kept);
}

function flattenSessions(byMachine: Map<string, ArchivedSessionData>): SessionWithMachine[] {
  return [...byMachine.values()].flatMap((data) =>
    data.sessions.map((session) => ({
      ...session,
      machineId: data.machineId,
      machineName: data.machineName,
      agentUrl: data.agentUrl,
    }))
  );
}

function findSession(
  byMachine: SessionsByMachine,
  machineId: string,
  sessionName: string
): SessionInfo | null {
  return byMachine.get(machineId)?.sessions.find((s) => s.name === sessionName) ?? null;
}

function withSessionsList(
  prev: SessionsByMachine,
  machine: Machine,
  sessions: SessionInfo[]
): SessionsByMachine {
  return new Map(prev).set(machine.id, {
    machineId: machine.id,
    machineName: machine.name,
    agentUrl: agentUrlOf(machine),
    sessions: limitSessions(sessions, MAX_SESSIONS_PER_MACHINE),
    lastFetch: Date.now(),
    error: null,
    wsConnected: true,
  });
}

function withoutSession(
  prev: SessionsByMachine,
  machineId: string,
  sessionName: string
): SessionsByMachine {
  const existing = prev.get(machineId);
  if (!existing || !existing.sessions.some((s) => s.name === sessionName)) return prev;
  return new Map(prev).set(machineId, {
    ...existing,
    sessions: existing.sessions.filter((s) => s.name !== sessionName),
    lastFetch: Date.now(),
  });
}

function withStatusUpdate(
  prev: SessionsByMachine,
  machineId: string,
  update: WSSessionInfo
): SessionsByMachine {
  const existing = prev.get(machineId);
  if (!existing || !existing.sessions.some((s) => s.name === update.name)) return prev;
  const sessions = existing.sessions.map((s) =>
    s.name === update.name
      ? {
          ...s,
          status: update.status,
          attentionReason: update.attentionReason,
          statusSource: update.statusSource,
          lastStatusChange: update.lastStatusChange,
        }
      : s
  );
  return new Map(prev).set(machineId, { ...existing, sessions });
}

function withWsOpened(prev: SessionsByMachine, machine: Machine): SessionsByMachine {
  const existing = prev.get(machine.id);
  if (existing) {
    return new Map(prev).set(machine.id, { ...existing, wsConnected: true, error: null });
  }
  return new Map(prev).set(machine.id, {
    machineId: machine.id,
    machineName: machine.name,
    agentUrl: agentUrlOf(machine),
    sessions: [],
    lastFetch: Date.now(),
    error: null,
    wsConnected: true,
  });
}

function withWsClosed(prev: SessionsByMachine, machineId: string): SessionsByMachine {
  const existing = prev.get(machineId);
  if (!existing || !existing.wsConnected) return prev;
  return new Map(prev).set(machineId, { ...existing, wsConnected: false });
}

/**
 * Applies HTTP poll results. A failed poll never clobbers a machine whose
 * WebSocket is healthy, and results for machines removed meanwhile are dropped.
 */
function withPollResults(
  prev: SessionsByMachine,
  results: PollResult[],
  knownIds: ReadonlySet<string>,
  wsConnectedIds: ReadonlySet<string>
): SessionsByMachine {
  const updates = results
    .filter(({ machine }) => knownIds.has(machine.id))
    .filter(({ machine, sessions }) => sessions !== null || !wsConnectedIds.has(machine.id))
    .map(({ machine, sessions, error }): [string, MachineSessionData] => [
      machine.id,
      {
        machineId: machine.id,
        machineName: machine.name,
        agentUrl: agentUrlOf(machine),
        sessions: sessions ?? [],
        lastFetch: Date.now(),
        error,
        wsConnected: wsConnectedIds.has(machine.id),
      },
    ]);
  return updates.length === 0 ? prev : new Map([...prev, ...updates]);
}

function withArchivedSession(
  prev: ArchivedByMachine,
  machine: Machine,
  session: SessionInfo
): ArchivedByMachine {
  const existing = prev.get(machine.id);
  if (!existing) {
    return new Map(prev).set(machine.id, {
      machineId: machine.id,
      machineName: machine.name,
      agentUrl: agentUrlOf(machine),
      sessions: [session],
    });
  }
  if (existing.sessions.some((s) => s.name === session.name)) return prev;
  return new Map(prev).set(machine.id, {
    ...existing,
    sessions: limitSessions([session, ...existing.sessions], MAX_ARCHIVED_PER_MACHINE),
  });
}

async function fetchSessions(machine: Machine): Promise<PollResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(buildApiUrl(agentUrlOf(machine), '/api/sessions'), {
      signal: controller.signal,
      headers: authHeaders(authTokenOf(machine)),
    });
    if (!response.ok) throw new Error('Failed to fetch sessions');

    const sessions: SessionInfo[] = await response.json();
    return { machine, sessions: limitSessions(sessions, MAX_SESSIONS_PER_MACHINE), error: null };
  } catch (err) {
    const error = isAbortError(err) ? 'Agent not responding' : 'Could not connect to agent';
    return { machine, sessions: null, error };
  } finally {
    clearTimeout(timeout);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════════════════════════

export function SessionPollingProvider({ children }: { children: ReactNode }) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [sessionsByMachine, setSessionsByMachine] = useState<SessionsByMachine>(() => new Map());
  const [archivedByMachine, setArchivedByMachine] = useState<ArchivedByMachine>(() => new Map());
  const [loadingMachines, setLoadingMachines] = useState<Set<string>>(() => new Set());

  // Synchronous mirrors of state. Socket handlers and timers outlive the render
  // that created them, so they read these instead of a stale closure.
  const machinesRef = useRef<Machine[]>(machines);
  const sessionsRef = useRef<SessionsByMachine>(sessionsByMachine);

  const wsConnectionsRef = useRef<Map<string, WebSocket>>(new Map());
  const wsConnectionKeysRef = useRef<Map<string, string>>(new Map()); // Machines we keep a socket (or a pending reconnect) for
  const wsConnectedRef = useRef<Set<string>>(new Set()); // Track connected machines via ref for polling
  const wsReconnectDelaysRef = useRef<Map<string, number>>(new Map());
  const wsReconnectTimeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const activeReconnectionsRef = useRef<Set<string>>(new Set()); // Track machines currently reconnecting
  const connectWebSocketRef = useRef<(machine: Machine) => void>(() => {});
  const onNeedsAttentionRef = useRef<NeedsAttentionCallback | undefined>(undefined);

  const setOnNeedsAttention = useCallback((callback: NeedsAttentionCallback | undefined) => {
    onNeedsAttentionRef.current = callback;
  }, []);

  // NOTE: Machines are now managed by the parent component (from localStorage)
  // We no longer fetch from /api/machines - the dashboard is stateless!

  // Must stay the first effect so later effects and timers see the current list.
  useEffect(() => {
    machinesRef.current = machines;
  }, [machines]);

  /**
   * Single write path for session state. The next value is computed eagerly
   * from the mirror, so updates are sequential and never re-run by React
   * (Strict Mode replays updater functions, which must not have side effects).
   */
  const updateSessions = useCallback((update: (prev: SessionsByMachine) => SessionsByMachine) => {
    const next = update(sessionsRef.current);
    if (next === sessionsRef.current) return;
    sessionsRef.current = next;
    setSessionsByMachine(next);
  }, []);

  const handleSessionsMessage = useCallback(
    (machine: Machine, msg: WSSessionsMessageFromAgent) => {
      switch (msg.type) {
        case 'sessions-list':
          wsLogger.info(`Received sessions-list: ${msg.sessions.length} sessions`);
          updateSessions((prev) => withSessionsList(prev, machine, msg.sessions));
          break;

        case 'session-removed':
          wsLogger.info(`Session removed: ${msg.sessionName}`);
          updateSessions((prev) => withoutSession(prev, machine.id, msg.sessionName));
          break;

        case 'session-archived':
          wsLogger.info(`Session archived: ${msg.sessionName}`);
          updateSessions((prev) => withoutSession(prev, machine.id, msg.session.name));
          setArchivedByMachine((prev) => withArchivedSession(prev, machine, msg.session));
          break;

        case 'version-info':
          wsLogger.info(`Agent version: ${msg.agentVersion}`);
          break;

        case 'update-pending':
          wsLogger.info(`Agent updating to ${msg.targetVersion}: ${msg.message}`);
          // Agent will restart, WebSocket will reconnect automatically
          break;

        case 'status-update': {
          wsLogger.info(`Status update: ${msg.session.name} -> ${msg.session.status}`);
          const previous = findSession(sessionsRef.current, machine.id, msg.session.name);
          updateSessions((prev) => withStatusUpdate(prev, machine.id, msg.session));

          // Notify once, when the status changes TO needs_attention
          const becameNeedsAttention =
            previous !== null &&
            msg.session.status === 'needs_attention' &&
            previous.status !== 'needs_attention';
          if (becameNeedsAttention) {
            onNeedsAttentionRef.current?.(msg.session.name);
          }
          break;
        }
      }
    },
    [updateSessions]
  );

  // Schedule reconnection with exponential backoff.
  // Limit concurrent reconnections to prevent resource exhaustion.
  const scheduleReconnect = useCallback((machine: Machine) => {
    const currentDelay = wsReconnectDelaysRef.current.get(machine.id) || WS_RECONNECT_BASE_DELAY;
    wsReconnectDelaysRef.current.set(
      machine.id,
      Math.min(currentDelay * 2, WS_RECONNECT_MAX_DELAY)
    );

    // Add extra delay if too many concurrent reconnections
    const concurrentCount = activeReconnectionsRef.current.size;
    const effectiveDelay =
      concurrentCount >= MAX_CONCURRENT_RECONNECTIONS
        ? currentDelay + concurrentCount * WS_RECONNECT_STAGGER_DELAY
        : currentDelay;

    wsLogger.info(`Reconnecting to ${machine.name} in ${effectiveDelay}ms`, { concurrentCount });

    activeReconnectionsRef.current.add(machine.id);
    clearTimeout(wsReconnectTimeoutsRef.current.get(machine.id));

    const timeout = setTimeout(() => {
      wsReconnectTimeoutsRef.current.delete(machine.id);
      activeReconnectionsRef.current.delete(machine.id);
      // Only reconnect if the machine still exists and is online right now
      const currentMachine = machinesRef.current.find((m) => m.id === machine.id);
      if (currentMachine && isOnline(currentMachine)) {
        connectWebSocketRef.current(currentMachine);
      }
    }, effectiveDelay);

    wsReconnectTimeoutsRef.current.set(machine.id, timeout);
  }, []);

  // Connect WebSocket for a machine
  const connectWebSocket = useCallback(
    (machine: Machine) => {
      const connections = wsConnectionsRef.current;
      // Include app version in WebSocket URL for auto-update detection
      const appVersion = process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0';
      const wsUrl = buildWebSocketUrl(
        agentUrlOf(machine),
        `/sessions?v=${encodeURIComponent(appVersion)}`
      );

      // Close existing connection if any. Detach it first so its handlers see it is stale.
      const existingWs = connections.get(machine.id);
      if (existingWs) {
        connections.delete(machine.id);
        existingWs.close();
      }
      wsConnectionKeysRef.current.set(machine.id, connectionKeyOf(machine));

      wsLogger.info(`Connecting to ${wsUrl} for machine ${machine.name}`);

      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl, wsSubprotocols(authTokenOf(machine)));
      } catch (err) {
        wsLogger.error(`Failed to create WebSocket for ${machine.name}`, err);
        wsConnectionKeysRef.current.delete(machine.id);
        return;
      }
      connections.set(machine.id, ws);

      // A socket that was replaced or torn down must not touch shared state,
      // otherwise its late events would undo the work of its successor.
      const isCurrent = () => connections.get(machine.id) === ws;

      ws.onopen = () => {
        if (!isCurrent()) return;
        wsLogger.info(`Connected to ${machine.name}`);
        wsReconnectDelaysRef.current.set(machine.id, WS_RECONNECT_BASE_DELAY);
        wsConnectedRef.current.add(machine.id); // Track via ref for polling
        updateSessions((prev) => withWsOpened(prev, machine));
      };

      ws.onmessage = (event) => {
        if (!isCurrent()) return;
        const msg = parseSessionsMessage(event.data);
        if (msg) handleSessionsMessage(machine, msg);
      };

      ws.onclose = (event) => {
        if (!isCurrent()) return;
        wsLogger.info(`Disconnected from ${machine.name}`, {
          code: event.code,
          reason: event.reason,
        });
        connections.delete(machine.id);
        wsConnectedRef.current.delete(machine.id);
        updateSessions((prev) => withWsClosed(prev, machine.id));
        scheduleReconnect(machine);
      };

      ws.onerror = () => {
        if (!isCurrent()) return;
        wsLogger.warn(`Connection error for ${machine.name} (will retry)`);
      };
    },
    [handleSessionsMessage, scheduleReconnect, updateSessions]
  );

  useEffect(() => {
    connectWebSocketRef.current = connectWebSocket;
  }, [connectWebSocket]);

  // Close a machine's socket and cancel its pending reconnect
  const disconnectMachine = useCallback((machineId: string) => {
    const ws = wsConnectionsRef.current.get(machineId);
    wsConnectionsRef.current.delete(machineId); // Detach first: its close event must be ignored
    wsConnectionKeysRef.current.delete(machineId);
    wsConnectedRef.current.delete(machineId);
    wsReconnectDelaysRef.current.delete(machineId);
    ws?.close();

    clearTimeout(wsReconnectTimeoutsRef.current.get(machineId));
    wsReconnectTimeoutsRef.current.delete(machineId);
    activeReconnectionsRef.current.delete(machineId);
  }, []);

  // Manage WebSocket connections by diffing the machine list: only sockets of
  // removed, offline or changed machines are closed and only missing ones are opened.
  useEffect(() => {
    const onlineMachines = new Map(machines.filter(isOnline).map((m) => [m.id, m]));

    for (const [machineId, connectionKey] of [...wsConnectionKeysRef.current]) {
      const machine = onlineMachines.get(machineId);
      if (machine && connectionKeyOf(machine) === connectionKey) continue;
      disconnectMachine(machineId);
      if (!machine) updateSessions((prev) => withWsClosed(prev, machineId));
    }

    for (const machine of onlineMachines.values()) {
      if (!wsConnectionKeysRef.current.has(machine.id)) connectWebSocket(machine);
    }
  }, [machines, connectWebSocket, disconnectMachine, updateSessions]);

  // Forget everything we know about machines that are no longer in the list
  useEffect(() => {
    const knownIds = new Set(machines.map((m) => m.id));
    updateSessions((prev) => pruneToIds(prev, knownIds));
    setArchivedByMachine((prev) => pruneToIds(prev, knownIds));
    setLoadingMachines((prev) => {
      const kept = [...prev].filter((id) => knownIds.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [machines, updateSessions]);

  // Tear everything down, but only when the provider unmounts
  useEffect(() => {
    const connections = wsConnectionsRef.current;
    const connectionKeys = wsConnectionKeysRef.current;
    const connected = wsConnectedRef.current;
    const reconnectTimeouts = wsReconnectTimeoutsRef.current;
    const activeReconnections = activeReconnectionsRef.current;

    return () => {
      const sockets = [...connections.values()];
      connections.clear(); // Detach first: close events of these sockets must not reconnect
      connectionKeys.clear();
      connected.clear();
      sockets.forEach((ws) => ws.close());

      reconnectTimeouts.forEach((timeout) => clearTimeout(timeout));
      reconnectTimeouts.clear();
      activeReconnections.clear();
    };
  }, []);

  // Fetch archived sessions for a machine
  const fetchArchivedSessions = useCallback(async (machine: Machine): Promise<void> => {
    const agentUrl = agentUrlOf(machine);

    try {
      const response = await fetch(buildApiUrl(agentUrl, '/api/sessions/archived'), {
        headers: authHeaders(authTokenOf(machine)),
      });
      if (!response.ok) return;

      const sessions: SessionInfo[] = await response.json();
      // The machine may have been removed while the request was in flight
      if (!machinesRef.current.some((m) => m.id === machine.id)) return;

      setArchivedByMachine((prev) =>
        new Map(prev).set(machine.id, {
          machineId: machine.id,
          machineName: machine.name,
          agentUrl,
          sessions: limitSessions(sessions, MAX_ARCHIVED_PER_MACHINE),
        })
      );
    } catch (err) {
      archivedLogger.warn('Could not fetch archived sessions (agent unreachable)', {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  // Fetch archived sessions when machines change
  useEffect(() => {
    for (const machine of machines.filter(isOnline)) {
      // Fetch archived sessions if not already loaded
      if (!archivedByMachine.has(machine.id)) {
        fetchArchivedSessions(machine);
      }
    }
  }, [machines, archivedByMachine, fetchArchivedSessions]);

  const applyPollResults = useCallback(
    (results: PollResult[]) => {
      const knownIds = new Set(machinesRef.current.map((m) => m.id));
      updateSessions((prev) => withPollResults(prev, results, knownIds, wsConnectedRef.current));
    },
    [updateSessions]
  );

  // Fallback HTTP polling (less frequent when WS is working)
  useEffect(() => {
    const onlineMachines = machines.filter(isOnline);
    if (onlineMachines.length === 0) return;

    let cancelled = false;
    const pollAllMachines = async () => {
      pollingLogger.info(`HTTP polling ${onlineMachines.length} machines`);
      const results = await Promise.all(onlineMachines.map(fetchSessions));
      if (!cancelled) applyPollResults(results);
    };

    pollAllMachines();
    const interval = setInterval(pollAllMachines, FALLBACK_POLLING_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [machines, applyPollResults]);

  const refreshMachine = useCallback(
    async (machineId: string) => {
      const machine = machinesRef.current.find((m) => m.id === machineId);
      if (!machine || !isOnline(machine)) return;

      setLoadingMachines((prev) => new Set(prev).add(machineId));
      try {
        applyPollResults([await fetchSessions(machine)]);
      } finally {
        setLoadingMachines((prev) => new Set([...prev].filter((id) => id !== machineId)));
      }
    },
    [applyPollResults]
  );

  // All sessions across all machines, flattened with machine context.
  // Memoized so consumers get a stable array until the sessions really change.
  const allSessions = useMemo(() => flattenSessions(sessionsByMachine), [sessionsByMachine]);
  const archivedSessions = useMemo(() => flattenSessions(archivedByMachine), [archivedByMachine]);

  const getAllSessions = useCallback(() => allSessions, [allSessions]);
  const getArchivedSessions = useCallback(() => archivedSessions, [archivedSessions]);

  const getSessionsForMachine = useCallback(
    (machineId: string) => sessionsByMachine.get(machineId)?.sessions ?? NO_SESSIONS,
    [sessionsByMachine]
  );

  // Get a specific session by machine and name
  const getSession = useCallback(
    (machineId: string, sessionName: string) =>
      findSession(sessionsByMachine, machineId, sessionName),
    [sessionsByMachine]
  );

  const isLoading = useCallback(
    (machineId: string) => loadingMachines.has(machineId),
    [loadingMachines]
  );

  const getError = useCallback(
    (machineId: string) => sessionsByMachine.get(machineId)?.error ?? null,
    [sessionsByMachine]
  );

  const isWsConnected = useCallback(
    (machineId: string) => sessionsByMachine.get(machineId)?.wsConnected ?? false,
    [sessionsByMachine]
  );

  const value = useMemo<SessionPollingContextValue>(
    () => ({
      sessionsByMachine,
      machines,
      getSessionsForMachine,
      getAllSessions,
      getArchivedSessions,
      getSession,
      refreshMachine,
      setMachines,
      isLoading,
      getError,
      isWsConnected,
      setOnNeedsAttention,
    }),
    [
      sessionsByMachine,
      machines,
      getSessionsForMachine,
      getAllSessions,
      getArchivedSessions,
      getSession,
      refreshMachine,
      isLoading,
      getError,
      isWsConnected,
      setOnNeedsAttention,
    ]
  );

  return <SessionPollingContext.Provider value={value}>{children}</SessionPollingContext.Provider>;
}

export function useSessionPolling() {
  const context = useContext(SessionPollingContext);
  if (!context) {
    throw new Error('useSessionPolling must be used within SessionPollingProvider');
  }
  return context;
}

// Re-export types for convenience
export type { SessionInfo, SessionWithMachine };
