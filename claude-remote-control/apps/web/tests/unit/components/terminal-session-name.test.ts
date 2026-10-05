import { describe, it, expect } from 'vitest';
import {
  SESSION_NAME_MAX_LENGTH,
  buildSessionName,
  generateSessionName,
  sanitizeSessionNamePart,
} from '@/components/Terminal/constants';

/** The pattern the agent enforces for session names. */
const AGENT_SESSION_NAME_PATTERN = /^[\w-]{1,100}$/;

describe('sanitizeSessionNamePart', () => {
  it('keeps letters, digits, underscores and dashes untouched', () => {
    expect(sanitizeSessionNamePart('My_project-2')).toBe('My_project-2');
  });

  it.each([
    ['dots', 'my.app.v2', 'my_app_v2'],
    ['spaces', 'my cool app', 'my_cool_app'],
    ['slashes', 'apps/web\\src', 'apps_web_src'],
    ['shell metacharacters', 'a;b$(c)`d`', 'a_b__c__d_'],
    ['unicode letters', 'проект', '______'],
  ])('replaces %s with underscores', (_label, input, expected) => {
    expect(sanitizeSessionNamePart(input)).toBe(expected);
  });

  it('returns an empty string for an empty project', () => {
    expect(sanitizeSessionNamePart('')).toBe('');
  });
});

describe('buildSessionName', () => {
  it('joins the sanitised project and the suffix with a double dash', () => {
    expect(buildSessionName('my.app', 'new')).toBe('my_app--new');
  });

  it('truncates the project so the whole name fits the limit and keeps the suffix', () => {
    const name = buildSessionName('p'.repeat(300), 'brave-lion-42');

    expect(name).toHaveLength(SESSION_NAME_MAX_LENGTH);
    expect(name.endsWith('--brave-lion-42')).toBe(true);
  });

  it('supports the root terminal, which has no project', () => {
    expect(buildSessionName('', 'new')).toBe('--new');
  });
});

describe('generateSessionName', () => {
  it.each([
    ['a plain project', 'demo-project'],
    ['dots', 'my.app.v2'],
    ['spaces', 'my cool app'],
    ['slashes', 'apps/web'],
    ['unicode', 'проект-日本語-🚀'],
    ['the root terminal (empty project)', ''],
    ['a very long project', 'x'.repeat(500)],
  ])('produces a name the agent accepts for %s', (_label, project) => {
    const name = generateSessionName(project);

    expect(name).toMatch(AGENT_SESSION_NAME_PATTERN);
    expect(name).toMatch(/--[a-z]+-[a-z]+-\d{1,2}$/);
  });

  it('keeps a valid project name readable in the session name', () => {
    expect(generateSessionName('demo-project').startsWith('demo-project--')).toBe(true);
  });
});
