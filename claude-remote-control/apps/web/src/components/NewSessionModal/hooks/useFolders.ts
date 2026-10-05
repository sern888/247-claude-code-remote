'use client';

import { useState, useEffect } from 'react';
import { buildApiUrl } from '@/lib/utils';
import { createLogger } from '@/lib/logger';

interface Machine {
  id: string;
  name: string;
  status: string;
  config?: {
    projects: string[];
    agentUrl?: string;
  };
}

const DEFAULT_AGENT_URL = 'localhost:4678';
const foldersLogger = createLogger('Folders');

/** The agent is external: only keep what really is a list of folder names. */
function toFolderList(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data.filter((item): item is string => typeof item === 'string');
}

async function fetchFolders(agentUrl: string, signal: AbortSignal): Promise<string[]> {
  const response = await fetch(buildApiUrl(agentUrl, '/api/folders'), { signal });
  if (!response.ok) throw new Error(`Agent responded with status ${response.status}`);
  return toFolderList(await response.json());
}

export function useFolders(selectedMachine: Machine | null) {
  const [folders, setFolders] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [loadingFolders, setLoadingFolders] = useState(false);

  useEffect(() => {
    const showFolders = (list: string[]) => {
      setFolders(list);
      setSelectedProject(list[0] ?? '');
    };

    if (!selectedMachine) {
      showFolders([]);
      setLoadingFolders(false);
      return;
    }

    // Guards against a slow response for a machine that is no longer selected
    const controller = new AbortController();
    let cancelled = false;
    const agentUrl = selectedMachine.config?.agentUrl || DEFAULT_AGENT_URL;
    const fallbackFolders = selectedMachine.config?.projects ?? [];

    const loadFolders = async () => {
      // Folders of the previously selected machine must not be offered for this one
      showFolders([]);
      setLoadingFolders(true);
      try {
        const folderList = await fetchFolders(agentUrl, controller.signal);
        if (!cancelled) showFolders(folderList);
      } catch (err) {
        if (cancelled) return;
        foldersLogger.warn('Could not fetch folders (agent unreachable)', {
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        // Never keep the previous machine's folders: fall back to the configured ones (or none)
        showFolders(fallbackFolders);
      } finally {
        if (!cancelled) setLoadingFolders(false);
      }
    };

    loadFolders();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedMachine]);

  const addFolder = (folderName: string) => {
    setFolders((prev) => [...prev, folderName].sort());
    setSelectedProject(folderName);
  };

  return {
    folders,
    selectedProject,
    setSelectedProject,
    loadingFolders,
    addFolder,
  };
}
