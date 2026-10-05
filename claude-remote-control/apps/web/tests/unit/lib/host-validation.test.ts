import { describe, it, expect } from 'vitest';
import {
  parseHostPort,
  classifyHostname,
  resolveAgentBaseUrl,
  isPublicHttpsUrl,
} from '@/lib/host-validation';

describe('parseHostPort', () => {
  it.each([
    ['localhost:4678', { hostname: 'localhost', port: 4678, host: 'localhost:4678' }],
    [
      'machine.tailnet.ts.net',
      { hostname: 'machine.tailnet.ts.net', port: null, host: 'machine.tailnet.ts.net' },
    ],
    [
      'Agent.Example.COM:443',
      { hostname: 'agent.example.com', port: 443, host: 'agent.example.com:443' },
    ],
    ['127.0.0.1:80', { hostname: '127.0.0.1', port: 80, host: '127.0.0.1:80' }],
    ['[::1]:4678', { hostname: '[::1]', port: 4678, host: '[::1]:4678' }],
  ])('accepts the strict host %s', (input, expected) => {
    expect(parseHostPort(input)).toEqual(expected);
  });

  it.each([
    ['a scheme', 'https://example.com'],
    ['a path', 'example.com/api'],
    ['a query', 'example.com?x=1'],
    ['a fragment', 'example.com#frag'],
    ['userinfo', 'user@example.com'],
    ['userinfo with password', 'user:pass@example.com:443'],
    ['a space', 'example.com evil.com'],
    ['a leading space', ' example.com'],
    ['a newline', 'example.com\n'],
    ['a tab', 'exa\tmple.com'],
    ['a backslash', 'example.com\\@evil.com'],
    ['an empty string', ''],
    ['an empty label', 'example..com'],
    ['a trailing dot', 'example.com.'],
    ['a leading hyphen', '-example.com'],
    ['an underscore', 'my_host.example.com'],
    ['port 0', 'example.com:0'],
    ['a port above 65535', 'example.com:65536'],
    ['a non-numeric port', 'example.com:http'],
    ['an empty port', 'example.com:'],
    ['an invalid IPv4-looking host', '1.2.3.4.5'],
    ['an IPv6 zone id', '[fe80::1%25eth0]'],
    ['a label longer than 63 chars', `${'a'.repeat(64)}.com`],
    ['a host longer than 255 chars', `${'a.'.repeat(130)}com`],
  ])('rejects %s', (_label, input) => {
    expect(parseHostPort(input)).toBeNull();
  });

  it.each([[undefined], [null], [42], [{ host: 'example.com' }], [['example.com']]])(
    'rejects the non-string value %j',
    (input) => {
      expect(parseHostPort(input)).toBeNull();
    }
  );

  it.each([
    ['2130706433', '127.0.0.1'],
    ['0x7f.0.0.1', '127.0.0.1'],
    ['127.1', '127.0.0.1'],
    ['0251.0376.0251.0376', '169.254.169.254'],
  ])('normalises the disguised IPv4 address %s to %s', (input, expected) => {
    expect(parseHostPort(input)?.hostname).toBe(expected);
  });
});

describe('classifyHostname', () => {
  it.each([
    'localhost',
    'app.localhost',
    'LOCALHOST',
    '127.0.0.1',
    '127.255.255.254',
    '[::1]',
    '[::ffff:7f00:1]',
    '[::ffff:0:7f00:1]',
    '[2002:7f00:1::]',
    'localhost.',
    'app.localhost.',
  ])('treats %s as loopback', (hostname) => {
    expect(classifyHostname(hostname)).toBe('loopback');
  });

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '100.127.255.255',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '192.0.0.8',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    'printer.local',
    'metadata.google.internal',
    'intranet',
    '[::]',
    '[fc00::1]',
    '[fd12:3456:789a::1]',
    '[fe80::1]',
    '[fec0::1]',
    '[ff02::1]',
    '[::ffff:a00:1]',
    '[::ffff:c0a8:101]',
    '[::a9fe:a9fe]',
    '[64:ff9b::a00:1]',
    '[::ffff:0:a00:1]',
    '[2002:a00:1::1]',
    '[2002:a9fe:a9fe::]',
    '[2001:0:4136:e378:8000:63bf:3fff:fdd2]',
    '[not-an-address]',
    'metadata.google.internal.',
    'printer.local.',
    'intranet.',
    'localhost..',
    '.example.com',
    'example..com',
    '',
  ])('treats %s as private', (hostname) => {
    expect(classifyHostname(hostname)).toBe('private');
  });

  it.each([
    'example.com',
    'machine.tailnet.ts.net',
    'localhost.example.com',
    'notlocalhost.com',
    '8.8.8.8',
    '100.63.255.255',
    '100.128.0.1',
    '172.15.0.1',
    '172.32.0.1',
    '169.253.0.1',
    '[2606:4700:4700::1111]',
    '[::ffff:808:808]',
    '[64:ff9b::808:808]',
    '[2002:808:808::1]',
    '[2001:4860:4860::8888]',
    'example.com.',
  ])('treats %s as public', (hostname) => {
    expect(classifyHostname(hostname)).toBe('public');
  });
});

describe('resolveAgentBaseUrl', () => {
  const development = { isProduction: false };
  const production = { isProduction: true };

  it('uses http for a loopback agent in development', () => {
    expect(resolveAgentBaseUrl('localhost:4678', development)).toEqual({
      ok: true,
      baseUrl: 'http://localhost:4678',
      host: 'localhost:4678',
      kind: 'loopback',
    });
    expect(resolveAgentBaseUrl('127.0.0.1:4678', development)).toMatchObject({
      ok: true,
      baseUrl: 'http://127.0.0.1:4678',
    });
  });

  it('uses https for a public agent host', () => {
    expect(resolveAgentBaseUrl('machine.tailnet.ts.net', production)).toEqual({
      ok: true,
      baseUrl: 'https://machine.tailnet.ts.net',
      host: 'machine.tailnet.ts.net',
      kind: 'public',
    });
  });

  it('does not treat a host that merely starts with "localhost" as loopback', () => {
    expect(resolveAgentBaseUrl('localhost.evil.com', development)).toMatchObject({
      ok: true,
      baseUrl: 'https://localhost.evil.com',
      kind: 'public',
    });
    expect(resolveAgentBaseUrl('127.0.0.1.evil.com', development)).toMatchObject({
      ok: true,
      baseUrl: 'https://127.0.0.1.evil.com',
      kind: 'public',
    });
  });

  it('uses https for a private (non-loopback) host in development', () => {
    expect(resolveAgentBaseUrl('192.168.1.10:4678', development)).toMatchObject({
      ok: true,
      baseUrl: 'https://192.168.1.10:4678',
      kind: 'private',
    });
  });

  it.each([
    'localhost:4678',
    'app.localhost',
    '127.0.0.1',
    '2130706433',
    '0x7f.0.0.1',
    '[::1]:4678',
    '10.0.0.5',
    '169.254.169.254',
    '192.168.0.1:8080',
    '[fd00::1]',
    'agent.local',
    'metadata.google.internal',
    'intranet',
  ])('blocks %s in production', (host) => {
    expect(resolveAgentBaseUrl(host, production)).toEqual({ ok: false, reason: 'blocked' });
  });

  it.each(['http://example.com', 'example.com/path', 'user@example.com', 'a b', '', null, 123])(
    'reports %j as invalid',
    (host) => {
      expect(resolveAgentBaseUrl(host, production)).toEqual({ ok: false, reason: 'invalid' });
      expect(resolveAgentBaseUrl(host, development)).toEqual({ ok: false, reason: 'invalid' });
    }
  );
});

describe('isPublicHttpsUrl', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc123',
    'https://updates.push.services.mozilla.com/wpush/v2/token',
    'https://web.push.apple.com/QGuQ',
  ])('accepts the push service endpoint %s', (url) => {
    expect(isPublicHttpsUrl(url)).toBe(true);
  });

  it.each([
    ['plain http', 'http://fcm.googleapis.com/fcm/send/abc'],
    ['a loopback host', 'https://localhost/push'],
    ['a loopback address', 'https://127.0.0.1/push'],
    ['the cloud metadata address', 'https://169.254.169.254/latest/meta-data'],
    ['a private address', 'https://10.0.0.1/push'],
    ['a disguised loopback address', 'https://2130706433/push'],
    ['an IPv6 loopback address', 'https://[::1]/push'],
    ['an internal name', 'https://service.internal/push'],
    ['a loopback name with a trailing dot', 'https://localhost.:8443/push'],
    ['an internal name with a trailing dot', 'https://metadata.google.internal./x'],
    ['a .local name with a trailing dot', 'https://printer.local./x'],
    ['a doubled trailing dot', 'https://localhost../x'],
    ['an IPv4-translated loopback address', 'https://[::ffff:0:127.0.0.1]/x'],
    ['a 6to4 address wrapping a private address', 'https://[2002:c0a8:101::1]/x'],
    ['fullwidth digits spelling a loopback address', 'https://\uff11\uff12\uff17.0.0.1/x'],
    ['an embedded newline', 'https://fcm.googleapis.com/fcm/send/abc\n[Push] forged log line'],
    ['an embedded tab', 'https://fcm.googleapis.com/\tfcm/send/abc'],
    ['a leading space', ' https://fcm.googleapis.com/fcm/send/abc'],
    ['embedded credentials', 'https://user:pass@fcm.googleapis.com/fcm/send/abc'],
    ['another scheme', 'file:///etc/passwd'],
    ['a relative URL', '/push'],
    ['an empty string', ''],
    ['an over-long URL', `https://example.com/${'a'.repeat(2100)}`],
  ])('rejects %s', (_label, url) => {
    expect(isPublicHttpsUrl(url)).toBe(false);
  });

  it.each([[undefined], [null], [42], [{}]])('rejects the non-string value %j', (value) => {
    expect(isPublicHttpsUrl(value)).toBe(false);
  });
});
