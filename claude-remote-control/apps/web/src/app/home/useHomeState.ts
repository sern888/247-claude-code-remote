'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useSessionPolling } from '@/contexts/SessionPollingContext';
import {
  useAgentConnections,
  type AgentConnection as DbAgentConnection,
} from '@/hooks/useAgentConnections';
import {
  NEW_SESSION_SUFFIX,
  buildSessionName,
  sanitizeSessionName,
} from '@/components/Terminal/constants';
import type { LocalMachine, SelectedSession } from './types';
import { DEFAULT_MACHINE_ID } from './types';

// Anything matching this is an open overlay that owns the Escape key
const ESCAPE_OWNER_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="search"]';

// Legacy type for backward compatibility with AgentConnectionSettings component
export interface AgentConnection {
  url: string;
  name?: string;
  method: 'localhost' | 'tailscale' | 'custom' | 'cloud';
  isCloud?: boolean;
  cloudAgentId?: string;
}

// Type for stored connections (from API)
export type StoredAgentConnection = DbAgentConnection;

// Helper to convert StoredAgentConnection to LocalMachine
function connectionToMachine(connection: StoredAgentConnection): LocalMachine {
  return {
    id: connection.id,
    name: connection.name,
    status: 'online',
    color: connection.color,
    config: {
      projects: [],
      agentUrl: connection.url,
      authToken: connection.authToken,
    },
  };
}

/**
 * True when an Escape key press belongs to something else: another handler
 * already consumed it, or a modal, dialog or search bar is open.
 */
function isEscapeClaimed(event: KeyboardEvent, hasOpenModal: boolean): boolean {
  if (event.defaultPrevented || hasOpenModal) return true;
  return document.querySelector(ESCAPE_OWNER_SELECTOR) !== null;
}

/**
 * React key of the session view. A session started here keeps the key it was
 * given at start, so the terminal is not remounted when the placeholder name
 * is replaced by the real one.
 */
export function getSessionViewKey(session: SelectedSession): string {
  return session.viewKey ?? `${session.machineId}-${session.project}-${session.sessionName}`;
}

export function useHomeState() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    setMachines: setPollingMachines,
    getAllSessions,
    getArchivedSessions,
  } = useSessionPolling();

  // Use the API-based hook for agent connections
  const {
    connections: agentConnections,
    loading: connectionsLoading,
    addConnection,
    removeConnection,
    updateConnection,
  } = useAgentConnections();

  const [connectionModalOpen, setConnectionModalOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [selectedSession, setSelectedSession] = useState<SelectedSession | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const hasRestoredFromUrl = useRef(false);
  const viewKeyCounterRef = useRef(0);
  const allSessions = getAllSessions();

  // All machines from all connections
  const machines: LocalMachine[] = useMemo(
    () => agentConnections.map(connectionToMachine),
    [agentConnections]
  );

  // Sync connections to polling context when they change
  useEffect(() => {
    setPollingMachines(machines);
  }, [machines, setPollingMachines]);

  // A view key that is unique per started session and survives its rename
  const createViewKey = useCallback((machineId: string, project: string) => {
    viewKeyCounterRef.current += 1;
    return `${machineId}-${project}-${NEW_SESSION_SUFFIX}-${viewKeyCounterRef.current}`;
  }, []);

  // Loading state
  const loading = connectionsLoading;

  // Legacy compatibility: get first connection as "agentConnection"
  const agentConnection = useMemo(() => {
    if (agentConnections.length === 0) return null;
    const first = agentConnections[0];
    return {
      url: first.url,
      name: first.name,
      method: first.method,
      isCloud: first.isCloud,
      cloudAgentId: first.cloudAgentId,
    };
  }, [agentConnections]);

  // Restore session from URL on load OR create new session from URL params
  useEffect(() => {
    if (hasRestoredFromUrl.current) return;

    const sessionParam = searchParams.get('session');
    const machineParam = searchParams.get('machine') || DEFAULT_MACHINE_ID;
    const createParam = searchParams.get('create') === 'true';
    const projectParam = searchParams.get('project');
    const planningProjectIdParam = searchParams.get('planningProjectId');

    // Handle session creation from URL (e.g., from planning modal)
    if (createParam && sessionParam && projectParam) {
      setSelectedSession({
        machineId: machineParam,
        // The name comes from the URL and is sent to the agent: keep it a valid session name
        sessionName: sanitizeSessionName(sessionParam),
        project: projectParam,
        planningProjectId: planningProjectIdParam || undefined,
        viewKey: createViewKey(machineParam, projectParam),
      });
      hasRestoredFromUrl.current = true;
      return;
    }

    // Handle restoring existing session from URL
    if (sessionParam && allSessions.length > 0) {
      const session = allSessions.find(
        (s) => s.name === sessionParam && s.machineId === machineParam
      );
      if (session) {
        setSelectedSession({
          machineId: machineParam,
          sessionName: sessionParam,
          project: session.project,
        });
        hasRestoredFromUrl.current = true;
      }
    }
  }, [searchParams, allSessions, createViewKey]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (agentConnection) {
          setNewSessionOpen(true);
        } else {
          setConnectionModalOpen(true);
        }
      }

      const hasOpenModal = newSessionOpen || connectionModalOpen;
      if (
        e.key === 'Escape' &&
        selectedSession &&
        !isFullscreen &&
        !isEscapeClaimed(e, hasOpenModal)
      ) {
        e.preventDefault();
        setSelectedSession(null);
        const params = new URLSearchParams(window.location.search);
        params.delete('session');
        params.delete('machine');
        const newUrl = params.toString() ? `?${params.toString()}` : '/';
        window.history.replaceState({}, '', newUrl);
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && selectedSession) {
        e.preventDefault();
        setIsFullscreen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [agentConnection, selectedSession, isFullscreen, newSessionOpen, connectionModalOpen]);

  const clearSessionFromUrl = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('session');
    params.delete('machine');
    const newUrl = params.toString() ? `?${params.toString()}` : '/';
    router.replace(newUrl, { scroll: false });
  }, [searchParams, router]);

  const handleSelectSession = useCallback(
    (machineId: string, sessionName: string, project: string) => {
      // An explicit choice wins over a pending restore from the URL
      hasRestoredFromUrl.current = true;
      // Re-selecting the open session keeps its view (and its terminal connection) as is
      setSelectedSession((prev) =>
        prev?.machineId === machineId && prev.sessionName === sessionName
          ? prev
          : { machineId, sessionName, project }
      );

      const params = new URLSearchParams(searchParams.toString());
      params.set('session', sessionName);
      params.set('machine', machineId);
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [searchParams, router]
  );

  const handleStartSession = useCallback(
    (machineId: string, project: string, environmentId?: string) => {
      // The URL now describes this session: restoring from it later would replace the
      // selection (losing viewKey/environmentId) and remount the terminal.
      hasRestoredFromUrl.current = true;
      // Placeholder until the agent confirms the real name (see handleSessionCreated)
      const newSessionName = buildSessionName(project, NEW_SESSION_SUFFIX);
      setSelectedSession({
        machineId,
        sessionName: newSessionName,
        project,
        environmentId,
        viewKey: createViewKey(machineId, project),
      });
      setNewSessionOpen(false);

      const params = new URLSearchParams(searchParams.toString());
      params.set('session', newSessionName);
      params.set('machine', machineId);
      params.set('create', 'true');
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, createViewKey]
  );

  const handleSessionCreated = useCallback(
    (actualSessionName: string) => {
      if (selectedSession) {
        // Only the name changes: viewKey is kept, so the terminal stays mounted
        setSelectedSession((prev) =>
          prev && prev.sessionName !== actualSessionName
            ? { ...prev, sessionName: actualSessionName }
            : prev
        );
        const params = new URLSearchParams(searchParams.toString());
        params.set('session', actualSessionName);
        params.delete('create');
        router.replace(`?${params.toString()}`, { scroll: false });
      }
    },
    [selectedSession, searchParams, router]
  );

  const handleSessionKilled = useCallback(
    (machineId: string, sessionName: string) => {
      if (selectedSession?.sessionName === sessionName) {
        setSelectedSession(null);
        clearSessionFromUrl();
      }
    },
    [selectedSession, clearSessionFromUrl]
  );

  const handleSessionArchived = useCallback(
    (machineId: string, sessionName: string) => {
      if (selectedSession?.sessionName === sessionName) {
        setSelectedSession(null);
        clearSessionFromUrl();
      }
    },
    [selectedSession, clearSessionFromUrl]
  );

  // Add a new connection (uses API)
  const handleConnectionSaved = useCallback(
    async (connection: AgentConnection) => {
      try {
        await addConnection({
          url: connection.url,
          name: connection.name || 'Agent',
          method: connection.method,
        });
        // The hook automatically updates the connections state
      } catch (error) {
        console.error('Failed to save connection:', error);
      }
    },
    [addConnection]
  );

  // Remove a specific connection by ID (uses API)
  const handleConnectionRemoved = useCallback(
    async (connectionId: string) => {
      try {
        await removeConnection(connectionId);

        // If selected session was on this machine, clear it
        if (selectedSession?.machineId === connectionId) {
          setSelectedSession(null);
          clearSessionFromUrl();
        }
      } catch (error) {
        console.error('Failed to remove connection:', error);
      }
    },
    [selectedSession, clearSessionFromUrl, removeConnection]
  );

  // Legacy: clear all connections (kept for backward compatibility)
  const handleConnectionCleared = useCallback(async () => {
    // Remove all connections one by one
    for (const conn of agentConnections) {
      try {
        await removeConnection(conn.id);
      } catch (error) {
        console.error('Failed to remove connection:', error);
      }
    }
    setSelectedSession(null);
    clearSessionFromUrl();
  }, [agentConnections, removeConnection, clearSessionFromUrl]);

  // Edit an existing connection (name, color, etc.)
  const handleConnectionEdited = useCallback(
    async (connectionId: string, data: { name?: string; color?: string }) => {
      try {
        await updateConnection(connectionId, data);
      } catch (error) {
        console.error('Failed to update connection:', error);
        throw error;
      }
    },
    [updateConnection]
  );

  const getAgentUrl = useCallback(() => {
    if (!selectedSession) return '';
    const connection = agentConnections.find((c) => c.id === selectedSession.machineId);
    return connection?.url || '';
  }, [selectedSession, agentConnections]);

  const getAuthToken = useCallback(() => {
    if (!selectedSession) return undefined;
    const connection = agentConnections.find((c) => c.id === selectedSession.machineId);
    return connection?.authToken;
  }, [selectedSession, agentConnections]);

  const getSelectedSessionInfo = useCallback(() => {
    if (!selectedSession) return undefined;
    return allSessions.find(
      (s) => s.name === selectedSession.sessionName && s.machineId === selectedSession.machineId
    );
  }, [selectedSession, allSessions]);

  // Legacy: currentMachine is the first machine (for backward compatibility)
  const currentMachine: LocalMachine | null = machines.length > 0 ? machines[0] : null;

  return {
    // State
    loading,
    agentConnection, // Legacy: first connection
    agentConnections, // NEW: all connections
    connectionModalOpen,
    setConnectionModalOpen,
    newSessionOpen,
    setNewSessionOpen,
    selectedSession,
    setSelectedSession,
    isFullscreen,
    setIsFullscreen,
    allSessions,
    currentMachine, // Legacy: first machine
    machines, // NEW: all machines

    // Data fetchers
    getArchivedSessions,
    getAgentUrl,
    getAuthToken,
    getSelectedSessionInfo,

    // Handlers
    handleSelectSession,
    handleStartSession,
    handleSessionCreated,
    handleSessionKilled,
    handleSessionArchived,
    handleConnectionSaved,
    handleConnectionRemoved, // NEW: remove specific connection
    handleConnectionEdited, // NEW: edit connection (name, color)
    handleConnectionCleared,
    clearSessionFromUrl,
  };
}
