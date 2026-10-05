import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  ServiceManager,
  ServiceStatus,
  ServiceInstallOptions,
  ServiceResult,
} from './index.js';
import { getAgentPaths, getTestableHomedir } from '../lib/paths.js';
import { loadConfig } from '../lib/config.js';
import { checkTmux } from '../lib/prerequisites.js';

const execAsync = promisify(exec);

const SERVICE_NAME = '247-agent';

export class SystemdService implements ServiceManager {
  platform = 'linux' as const;
  serviceName = SERVICE_NAME;

  private get unitPath(): string {
    return join(getTestableHomedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
  }

  async status(): Promise<ServiceStatus> {
    const installed = existsSync(this.unitPath);
    let running = false;
    let enabled = false;
    let pid: number | undefined;

    if (installed) {
      try {
        const { stdout: statusOutput } = await execAsync(
          `systemctl --user is-active ${SERVICE_NAME} 2>/dev/null || true`
        );
        running = statusOutput.trim() === 'active';

        const { stdout: enabledOutput } = await execAsync(
          `systemctl --user is-enabled ${SERVICE_NAME} 2>/dev/null || true`
        );
        enabled = enabledOutput.trim() === 'enabled';

        if (running) {
          const { stdout: pidOutput } = await execAsync(
            `systemctl --user show ${SERVICE_NAME} --property=MainPID --value 2>/dev/null || true`
          );
          const parsedPid = parseInt(pidOutput.trim(), 10);
          if (!isNaN(parsedPid) && parsedPid > 0) {
            pid = parsedPid;
          }
        }
      } catch {
        // Service not available
      }
    }

    return {
      installed,
      running,
      enabled,
      pid,
      configPath: installed ? this.unitPath : undefined,
    };
  }

  async install(options: ServiceInstallOptions = {}): Promise<ServiceResult> {
    const paths = getAgentPaths();

    // Verify tmux is installed
    const tmuxCheck = checkTmux();
    if (tmuxCheck.status === 'error') {
      return {
        success: false,
        error: 'tmux is not installed. Please install it first: sudo apt install tmux',
      };
    }

    const home = getTestableHomedir();

    // Create systemd user directory
    const systemdUserDir = join(home, '.config', 'systemd', 'user');
    if (!existsSync(systemdUserDir)) {
      mkdirSync(systemdUserDir, { recursive: true });
    }

    // Create log directory
    const logDir = join(home, '.local', 'log', '247-agent');
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    // Determine entry point
    const entryPoint = paths.isDev
      ? join(paths.agentRoot, 'src', 'index.ts')
      : join(paths.agentRoot, 'dist', 'index.js');

    // Generate unit content
    const unitContent = this.generateUnit({
      description: '247 Agent - The Vibe Company',
      nodePath: paths.nodePath,
      agentScript: entryPoint,
      workingDirectory: paths.agentRoot,
      isDev: paths.isDev,
      configPath: paths.configPath,
      port: loadConfig()?.agent.port,
    });

    writeFileSync(this.unitPath, unitContent, 'utf-8');

    // Reload systemd
    try {
      await execAsync('systemctl --user daemon-reload');
    } catch (err) {
      return { success: false, error: `Failed to reload systemd: ${(err as Error).message}` };
    }

    // Enable at boot if requested
    if (options.enableAtBoot ?? true) {
      try {
        await execAsync(`systemctl --user enable ${SERVICE_NAME}`);
      } catch (err) {
        return { success: false, error: `Failed to enable service: ${(err as Error).message}` };
      }
    }

    // Start now if requested
    if (options.startNow) {
      const startResult = await this.start();
      if (!startResult.success) {
        return { ...startResult, configPath: this.unitPath };
      }
    }

    return { success: true, configPath: this.unitPath };
  }

  async uninstall(): Promise<ServiceResult> {
    const status = await this.status();

    // Stop and disable first
    if (status.running) {
      await this.stop();
    }
    if (status.enabled) {
      try {
        await execAsync(`systemctl --user disable ${SERVICE_NAME}`);
      } catch {
        // Ignore disable errors
      }
    }

    // Remove unit file
    if (existsSync(this.unitPath)) {
      try {
        unlinkSync(this.unitPath);
        await execAsync('systemctl --user daemon-reload');
      } catch (err) {
        return { success: false, error: `Failed to remove unit file: ${(err as Error).message}` };
      }
    }

    return { success: true };
  }

  async start(): Promise<ServiceResult> {
    try {
      await execAsync(`systemctl --user start ${SERVICE_NAME}`);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async stop(): Promise<ServiceResult> {
    try {
      await execAsync(`systemctl --user stop ${SERVICE_NAME}`);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async restart(): Promise<ServiceResult> {
    try {
      await execAsync(`systemctl --user restart ${SERVICE_NAME}`);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  getLogPaths(): { stdout: string; stderr: string } {
    return {
      stdout: `journalctl --user -u ${SERVICE_NAME} -o cat`,
      stderr: `journalctl --user -u ${SERVICE_NAME} -p err -o cat`,
    };
  }

  private generateUnit(options: {
    description: string;
    nodePath: string;
    agentScript: string;
    workingDirectory: string;
    isDev: boolean;
    configPath: string;
    /** Port the agent must listen on; left out when no configuration could be loaded */
    port?: number;
  }): string {
    const portLine =
      options.port === undefined ? '' : `\nEnvironment="AGENT_247_PORT=${options.port}"`;

    let execStart: string;
    if (options.isDev) {
      execStart = `/usr/bin/env npx tsx ${options.agentScript}`;
    } else {
      execStart = `${options.nodePath} ${options.agentScript}`;
    }

    return `[Unit]
Description=${options.description}
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=${options.workingDirectory}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

Environment="AGENT_247_CONFIG=${options.configPath}"${portLine}
Environment="PATH=/usr/local/bin:/usr/bin:/bin"

[Install]
WantedBy=default.target
`;
  }
}
