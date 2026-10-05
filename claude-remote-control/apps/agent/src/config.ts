import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

export interface AgentConfig {
  machine: {
    id: string;
    name: string;
  };
  agent?: {
    port?: number;
    url?: string;
    /** Interface to listen on. Defaults to loopback; tunnels connect locally. */
    host?: string;
    /** Extra browser origins (self-hosted dashboards) allowed to call the agent */
    allowedOrigins?: string[];
  };
  projects: {
    basePath: string;
    whitelist: string[];
  };
  dashboard?: {
    apiUrl?: string;
    apiKey?: string;
  };
}

let cachedConfig: AgentConfig | null = null;

const CONFIG_DIR = resolve(homedir(), '.247');

/**
 * Get config file path based on profile name
 */
function getConfigPath(profileName?: string): string {
  if (profileName) {
    return resolve(CONFIG_DIR, 'profiles', `${profileName}.json`);
  }
  return resolve(CONFIG_DIR, 'config.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check the fields the agent cannot run without, so a damaged file fails at
 * startup with a clear message instead of somewhere inside a request handler.
 */
function validateConfig(raw: unknown, configPath: string): AgentConfig {
  const fail = (problem: string): never => {
    throw new Error(`Invalid configuration at ${configPath}: ${problem}`);
  };

  if (!isRecord(raw)) {
    return fail('expected a JSON object');
  }
  const { machine, projects } = raw;
  if (!isRecord(machine) || typeof machine.id !== 'string' || typeof machine.name !== 'string') {
    return fail('"machine.id" and "machine.name" must be strings');
  }
  if (!isRecord(projects) || typeof projects.basePath !== 'string') {
    return fail('"projects.basePath" must be a string');
  }

  const whitelist = Array.isArray(projects.whitelist)
    ? projects.whitelist.filter((entry): entry is string => typeof entry === 'string')
    : [];

  return {
    ...(raw as unknown as AgentConfig),
    projects: { ...(projects as AgentConfig['projects']), whitelist },
  };
}

/**
 * Read and validate one config file. A file that exists but cannot be used
 * is an error: silently falling back to another profile would start the
 * agent with a different machine id, port and project whitelist.
 */
function readConfigFile(configPath: string): AgentConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid configuration at ${configPath}: ${reason}`, { cause: err });
  }
  return validateConfig(parsed, configPath);
}

/**
 * Load agent configuration from ~/.247/
 * Uses AGENT_247_PROFILE env var if set, otherwise default config
 */
export function loadConfig(): AgentConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const profileName = process.env.AGENT_247_PROFILE || undefined;
  const configPath = getConfigPath(profileName);

  if (existsSync(configPath)) {
    cachedConfig = readConfigFile(configPath);
    const label = profileName ? `profile '${profileName}'` : 'default';
    console.log(`Loaded ${label} config from: ${configPath}`);
    return cachedConfig;
  }

  // If profile specified but not found, try default config
  if (profileName) {
    const defaultPath = getConfigPath();
    if (existsSync(defaultPath)) {
      cachedConfig = readConfigFile(defaultPath);
      console.log(`Profile '${profileName}' not found, using default: ${defaultPath}`);
      return cachedConfig;
    }
  }

  throw new Error(
    `No configuration found at ${configPath}\n` + `Run '247 init' to create configuration.`
  );
}

export const config = loadConfig();
