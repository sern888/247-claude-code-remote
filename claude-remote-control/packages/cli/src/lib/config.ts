import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getAgentPaths, ensureDirectories } from './paths.js';

export interface AgentConfig {
  machine: {
    id: string;
    name: string;
  };
  agent: {
    port: number;
  };
  projects: {
    basePath: string;
    whitelist: string[];
  };
  editor?: {
    enabled: boolean;
    portRange: { start: number; end: number };
    idleTimeout: number;
  };
}

const DEFAULT_CONFIG: AgentConfig = {
  machine: {
    id: '',
    name: '',
  },
  agent: {
    port: 4678,
  },
  projects: {
    basePath: '~/Dev',
    whitelist: [],
  },
  editor: {
    enabled: false,
    portRange: { start: 4680, end: 4699 },
    idleTimeout: 1800000,
  },
};

const MIN_PORT = 1;
const MAX_PORT = 65535;
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PROFILE_FILE_EXTENSION = '.json';

/**
 * True for an integer usable as a TCP port.
 */
export function isValidPort(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT
  );
}

/**
 * Parse a port given as text (CLI option or environment variable).
 * @param value - Raw text to parse
 * @param source - Name of the option or variable, used in the error message
 * @throws Error when the value is not an integer between 1 and 65535
 */
export function parsePort(value: string, source: string = 'port'): number {
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!isValidPort(port)) {
    throw new Error(
      `Invalid ${source} '${value}': must be an integer between ${MIN_PORT} and ${MAX_PORT}`
    );
  }
  return port;
}

function isDefaultProfile(profileName?: string | null): boolean {
  return !profileName || profileName === 'default';
}

/**
 * Explain why a profile name cannot be used, or return null when it is acceptable.
 * Profile names become file names, so anything that could escape the profiles
 * directory is rejected.
 */
export function getProfileNameError(profileName?: string | null): string | null {
  if (isDefaultProfile(profileName) || PROFILE_NAME_PATTERN.test(profileName as string)) {
    return null;
  }
  return (
    `Invalid profile name '${profileName}': use 1-64 letters, digits, '-' or '_', ` +
    'starting with a letter or digit'
  );
}

/**
 * Get the profiles directory path
 */
export function getProfilesDir(): string {
  const paths = getAgentPaths();
  return join(paths.configDir, 'profiles');
}

/**
 * Get the config file path for a specific profile
 * @param profileName - Profile name, or undefined/null/'default' for default config
 * @throws Error when the profile name is not a safe file name
 */
export function getProfilePath(profileName?: string | null): string {
  const paths = getAgentPaths();

  if (isDefaultProfile(profileName)) {
    return paths.configPath;
  }

  const nameError = getProfileNameError(profileName);
  if (nameError) {
    throw new Error(nameError);
  }

  return join(getProfilesDir(), `${profileName}${PROFILE_FILE_EXTENSION}`);
}

/**
 * List all available profiles
 */
export function listProfiles(): string[] {
  const paths = getAgentPaths();
  const profilesDir = getProfilesDir();

  const defaultProfiles = existsSync(paths.configPath) ? ['default'] : [];

  // Named profiles; files that could not have been created as profiles are ignored
  const namedProfiles = existsSync(profilesDir)
    ? readdirSync(profilesDir)
        .filter((file) => file.endsWith(PROFILE_FILE_EXTENSION))
        .map((file) => file.slice(0, -PROFILE_FILE_EXTENSION.length))
        .filter((name) => name !== 'default' && getProfileNameError(name) === null)
    : [];

  return [...defaultProfiles, ...namedProfiles];
}

/**
 * Check if a profile exists
 */
export function profileExists(profileName?: string | null): boolean {
  const configPath = getProfilePath(profileName);
  return existsSync(configPath);
}

/**
 * Delete a profile
 */
export function deleteProfile(profileName: string): boolean {
  if (!profileName || profileName === 'default') {
    throw new Error('Cannot delete default profile');
  }

  const configPath = getProfilePath(profileName);
  if (!existsSync(configPath)) {
    return false;
  }

  unlinkSync(configPath);
  return true;
}

/**
 * Return a copy of the config with AGENT_247_PORT / AGENT_247_PROJECTS applied.
 * The overrides only affect the running command; they are never written back.
 */
function applyEnvOverrides(config: AgentConfig): AgentConfig {
  const envPort = process.env.AGENT_247_PORT;
  const envProjects = process.env.AGENT_247_PROJECTS;

  return {
    ...config,
    agent: envPort ? { ...config.agent, port: parsePort(envPort, 'AGENT_247_PORT') } : config.agent,
    projects: envProjects ? { ...config.projects, basePath: envProjects } : config.projects,
  };
}

/**
 * Read and validate a config file exactly as stored on disk.
 */
function readConfigFile(configPath: string): AgentConfig {
  const config = JSON.parse(readFileSync(configPath, 'utf-8')) as AgentConfig;

  const storedPort: unknown = config.agent?.port;
  if (storedPort !== undefined && !isValidPort(storedPort)) {
    throw new Error(
      `Invalid agent.port in ${configPath}: must be an integer between ${MIN_PORT} and ${MAX_PORT}`
    );
  }
  return config;
}

function loadConfigWith(
  profileName: string | null | undefined,
  transform: (config: AgentConfig) => AgentConfig
): AgentConfig | null {
  const configPath = getProfilePath(profileName);

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    return transform(readConfigFile(configPath));
  } catch (err) {
    console.error(`Failed to load config: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Load the effective configuration from ~/.247/config.json or a profile,
 * with environment overrides applied. Use this to run things.
 * @param profileName - Profile name to load, or undefined for default
 */
export function loadConfig(profileName?: string | null): AgentConfig | null {
  return loadConfigWith(profileName, applyEnvOverrides);
}

/**
 * Load the configuration exactly as stored, without environment overrides.
 * Use this whenever the result is going to be saved again.
 * @param profileName - Profile name to load, or undefined for default
 */
export function loadStoredConfig(profileName?: string | null): AgentConfig | null {
  return loadConfigWith(profileName, (config) => config);
}

/**
 * Save configuration to ~/.247/config.json or a profile
 * @param config - Configuration to save
 * @param profileName - Profile name to save to, or undefined for default
 */
export function saveConfig(config: AgentConfig, profileName?: string | null): void {
  const configPath = getProfilePath(profileName);
  ensureDirectories();

  // Ensure profiles directory exists for named profiles
  if (profileName && profileName !== 'default') {
    const profilesDir = getProfilesDir();
    if (!existsSync(profilesDir)) {
      mkdirSync(profilesDir, { recursive: true });
    }
  }

  const content = JSON.stringify(config, null, 2);
  writeFileSync(configPath, content, 'utf-8');
}

/**
 * Generate a unique machine identity. Every profile must have its own.
 */
export function generateMachineId(): string {
  return randomUUID();
}

/**
 * Build the config for a new profile from an existing one. The copy gets its own
 * machine id so the two profiles never share an identity.
 */
export function copyConfigForNewProfile(
  source: AgentConfig,
  options: { port: number; machineName?: string }
): AgentConfig {
  return {
    ...source,
    machine: {
      id: generateMachineId(),
      name: options.machineName ?? source.machine.name,
    },
    agent: { ...source.agent, port: options.port },
  };
}

/**
 * Create a new configuration with defaults
 */
export function createConfig(options: {
  machineName: string;
  port?: number;
  projectsPath?: string;
}): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    machine: {
      id: generateMachineId(),
      name: options.machineName,
    },
    agent: {
      port: options.port ?? DEFAULT_CONFIG.agent.port,
    },
    projects: {
      basePath: options.projectsPath ?? DEFAULT_CONFIG.projects.basePath,
      whitelist: [],
    },
  };
}

/**
 * Check if configuration exists
 * @param profileName - Profile name to check, or undefined for default
 */
export function configExists(profileName?: string | null): boolean {
  const configPath = getProfilePath(profileName);
  return existsSync(configPath);
}
