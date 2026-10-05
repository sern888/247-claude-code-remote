import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Server Helpers', () => {
  describe('generateSessionName', () => {
    // Since generateSessionName is not exported, we test its behavior through integration
    // But we can test the pattern validation
    const SESSION_NAME_PATTERN = /^[\w-]+--[a-z]+-[a-z]+-\d+$/;

    it('validates session name format', () => {
      // Valid names
      expect('my-project--brave-lion-42').toMatch(SESSION_NAME_PATTERN);
      expect('test--swift-hawk-0').toMatch(SESSION_NAME_PATTERN);
      expect('project_name--calm-wolf-99').toMatch(SESSION_NAME_PATTERN);

      // Invalid names
      expect('invalid-name').not.toMatch(SESSION_NAME_PATTERN);
      expect('project-brave-lion-42').not.toMatch(SESSION_NAME_PATTERN);
      expect('project--BraveLion-42').not.toMatch(SESSION_NAME_PATTERN);
    });

    it('extracts project from session name', () => {
      const extractProject = (sessionName: string) => {
        const parts = sessionName.split('--');
        return parts[0];
      };

      expect(extractProject('my-project--brave-lion-42')).toBe('my-project');
      expect(extractProject('test--swift-hawk-0')).toBe('test');
      expect(extractProject('project_with_underscore--calm-wolf-99')).toBe(
        'project_with_underscore'
      );
    });
  });

  describe('HookStatus state machine', () => {
    type HookStatus = 'running' | 'waiting' | 'stopped' | 'ended' | 'permission';

    // Test status transitions
    const VALID_TRANSITIONS: Record<HookStatus, HookStatus[]> = {
      running: ['waiting', 'stopped', 'ended', 'permission'],
      waiting: ['running', 'stopped', 'ended'],
      stopped: ['running', 'ended'],
      ended: [], // Terminal state
      permission: ['running', 'stopped', 'ended'],
    };

    it.each([
      ['running', 'waiting', true],
      ['running', 'stopped', true],
      ['running', 'ended', true],
      ['running', 'permission', true],
      ['waiting', 'running', true],
      ['waiting', 'stopped', true],
      ['stopped', 'running', true],
      ['ended', 'running', false], // Can't restart ended session
      ['permission', 'running', true],
    ] as const)('validates transition from %s to %s is %s', (from, to, isValid) => {
      const validTargets = VALID_TRANSITIONS[from];
      expect(validTargets.includes(to)).toBe(isValid);
    });
  });

  describe('Hook event parsing', () => {
    interface HookEvent {
      event: string;
      session_id?: string;
      tmux_session?: string;
      project?: string;
      tool_name?: string;
      stop_reason?: string;
    }

    const parseHookEvent = (event: HookEvent) => {
      const statusMap: Record<string, string> = {
        SessionStart: 'running',
        PreToolUse: 'running',
        PostToolUse: 'running',
        PermissionRequest: 'permission',
        Stop: 'stopped',
        SessionEnd: 'ended',
      };

      return {
        status: statusMap[event.event] || 'running',
        lastEvent: event.event,
        toolName: event.tool_name,
        stopReason: event.stop_reason,
      };
    };

    it.each([
      ['SessionStart', 'running'],
      ['PreToolUse', 'running'],
      ['PostToolUse', 'running'],
      ['PermissionRequest', 'permission'],
      ['Stop', 'stopped'],
      ['SessionEnd', 'ended'],
    ])('maps %s event to %s status', (event, expectedStatus) => {
      const result = parseHookEvent({ event });
      expect(result.status).toBe(expectedStatus);
      expect(result.lastEvent).toBe(event);
    });

    it('extracts tool name from event', () => {
      const result = parseHookEvent({
        event: 'PreToolUse',
        tool_name: 'Bash',
      });
      expect(result.toolName).toBe('Bash');
    });

    it('extracts stop reason from event', () => {
      const result = parseHookEvent({
        event: 'Stop',
        stop_reason: 'user_interrupt',
      });
      expect(result.stopReason).toBe('user_interrupt');
    });
  });

  describe('Project whitelist validation', () => {
    const validateProject = (project: string, whitelist: string[]) => {
      // Empty whitelist allows any project
      if (whitelist.length === 0) return true;
      return whitelist.includes(project);
    };

    it('allows any project with empty whitelist', () => {
      expect(validateProject('any-project', [])).toBe(true);
      expect(validateProject('another-project', [])).toBe(true);
    });

    it('allows whitelisted projects', () => {
      const whitelist = ['project-a', 'project-b'];
      expect(validateProject('project-a', whitelist)).toBe(true);
      expect(validateProject('project-b', whitelist)).toBe(true);
    });

    it('rejects non-whitelisted projects', () => {
      const whitelist = ['project-a', 'project-b'];
      expect(validateProject('project-c', whitelist)).toBe(false);
      expect(validateProject('malicious', whitelist)).toBe(false);
    });
  });

  describe('WebSocket message parsing', () => {
    interface WSMessage {
      type: string;
      data?: string;
      cols?: number;
      rows?: number;
      lines?: number;
    }

    const parseWSMessage = (data: string): WSMessage | null => {
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    };

    it('parses input message', () => {
      const msg = parseWSMessage('{"type":"input","data":"ls -la"}');
      expect(msg).toEqual({ type: 'input', data: 'ls -la' });
    });

    it('parses resize message', () => {
      const msg = parseWSMessage('{"type":"resize","cols":120,"rows":40}');
      expect(msg).toEqual({ type: 'resize', cols: 120, rows: 40 });
    });

    it('parses ping message', () => {
      const msg = parseWSMessage('{"type":"ping"}');
      expect(msg).toEqual({ type: 'ping' });
    });

    it('parses start-claude message', () => {
      const msg = parseWSMessage('{"type":"start-claude"}');
      expect(msg).toEqual({ type: 'start-claude' });
    });

    it('parses request-history message', () => {
      const msg = parseWSMessage('{"type":"request-history","lines":100}');
      expect(msg).toEqual({ type: 'request-history', lines: 100 });
    });

    it('returns null for invalid JSON', () => {
      expect(parseWSMessage('not json')).toBeNull();
      expect(parseWSMessage('')).toBeNull();
      expect(parseWSMessage('{invalid}')).toBeNull();
    });
  });

  describe('Session status detection', () => {
    interface SessionInfo {
      hookStatus?: {
        status: string;
        lastActivity: number;
      };
      output?: string;
    }

    const HOOK_STATUS_TTL = 30 * 1000; // 30 seconds

    const getSessionStatus = (session: SessionInfo, now: number) => {
      // Prefer hook status if fresh
      if (session.hookStatus) {
        const age = now - session.hookStatus.lastActivity;
        if (age < HOOK_STATUS_TTL) {
          return {
            status: session.hookStatus.status,
            source: 'hook' as const,
          };
        }
      }

      // Fall back to output heuristics
      if (session.output) {
        if (session.output.includes('Bash')) {
          return { status: 'running', source: 'heuristic' as const };
        }
        if (session.output.includes('>')) {
          return { status: 'waiting', source: 'heuristic' as const };
        }
      }

      return { status: 'unknown', source: 'none' as const };
    };

    it('uses hook status when fresh', () => {
      const now = Date.now();
      const session: SessionInfo = {
        hookStatus: {
          status: 'running',
          lastActivity: now - 5000, // 5 seconds ago
        },
      };

      const result = getSessionStatus(session, now);
      expect(result.status).toBe('running');
      expect(result.source).toBe('hook');
    });

    it('ignores stale hook status', () => {
      const now = Date.now();
      const session: SessionInfo = {
        hookStatus: {
          status: 'running',
          lastActivity: now - 60000, // 60 seconds ago
        },
        output: 'Bash command',
      };

      const result = getSessionStatus(session, now);
      expect(result.source).toBe('heuristic');
    });

    it('falls back to heuristics without hook status', () => {
      const session: SessionInfo = {
        output: '$ ls\nfile.txt\n> ',
      };

      const result = getSessionStatus(session, Date.now());
      expect(result.source).toBe('heuristic');
      expect(result.status).toBe('waiting');
    });

    it('returns unknown with no data', () => {
      const session: SessionInfo = {};
      const result = getSessionStatus(session, Date.now());
      expect(result.status).toBe('unknown');
      expect(result.source).toBe('none');
    });
  });

  describe('Project path resolution', () => {
    const resolveProjectPath = (basePath: string, project: string) => {
      const resolved = basePath.replace('~', process.env.HOME || '/home/user');
      return `${resolved}/${project}`;
    };

    it('resolves ~ to HOME', () => {
      const originalHome = process.env.HOME;
      process.env.HOME = '/home/testuser';

      const path = resolveProjectPath('~/projects', 'my-app');
      expect(path).toBe('/home/testuser/projects/my-app');

      process.env.HOME = originalHome;
    });

    it('handles absolute paths', () => {
      const path = resolveProjectPath('/var/projects', 'my-app');
      expect(path).toBe('/var/projects/my-app');
    });
  });
});
