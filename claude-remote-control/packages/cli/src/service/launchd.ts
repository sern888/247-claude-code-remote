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

const SERVICE_LABEL = 'com.quivr.247';

export class LaunchdService implements ServiceManager {
  platform = 'macos' as const;
  serviceName = SERVICE_LABEL;

  private get plistPath(): string {
    return join(getTestableHomedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  }

  async status(): Promise<ServiceStatus> {
    const installed = existsSync(this.plistPath);
    let running = false;
    let pid: number | undefined;

    if (installed) {
      try {
        const { stdout } = await execAsync(`launchctl list | grep ${SERVICE_LABEL}`);
        const parts = stdout.trim().split(/\s+/);
        if (parts[0] && parts[0] !== '-') {
          pid = parseInt(parts[0], 10);
          running = !isNaN(pid);
        }
      } catch {
        // Service not running or not found in list
      }
    }

    return {
      installed,
      running,
      enabled: installed,
      pid,
      configPath: installed ? this.plistPath : undefined,
    };
  }

  async install(options: ServiceInstallOptions = {}): Promise<ServiceResult> {
    const paths = getAgentPaths();

    // Verify tmux is installed
    const tmuxCheck = checkTmux();
    if (tmuxCheck.status === 'error') {
      return {
        success: false,
        error: 'tmux is not installed. Please install it first: brew install tmux',
      };
    }

    const home = getTestableHomedir();

    // Create LaunchAgents directory if needed
    const launchAgentsDir = join(home, 'Library', 'LaunchAgents');
    if (!existsSync(launchAgentsDir)) {
      mkdirSync(launchAgentsDir, { recursive: true });
    }

    // Create log directory
    const logDir = join(home, 'Library', 'Logs', '247-agent');
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    const logs = this.getLogPaths();

    // Determine entry point
    const entryPoint = paths.isDev
      ? join(paths.agentRoot, 'src', 'index.ts')
      : join(paths.agentRoot, 'dist', 'index.js');

    // Generate plist content
    const plistContent = this.generatePlist({
      label: SERVICE_LABEL,
      nodePath: paths.nodePath,
      agentScript: entryPoint,
      workingDirectory: paths.agentRoot,
      stdoutPath: logs.stdout,
      stderrPath: logs.stderr,
      runAtLoad: options.enableAtBoot ?? true,
      keepAlive: true,
      isDev: paths.isDev,
      configPath: paths.configPath,
      port: loadConfig()?.agent.port,
    });

    writeFileSync(this.plistPath, plistContent, 'utf-8');

    // Load the service if requested
    if (options.startNow) {
      const startResult = await this.start();
      if (!startResult.success) {
        return { ...startResult, configPath: this.plistPath };
      }
    }

    return { success: true, configPath: this.plistPath };
  }

  async uninstall(): Promise<ServiceResult> {
    const status = await this.status();

    // Stop service first if running
    if (status.running) {
      await this.stop();
    }

    // Remove plist file
    if (existsSync(this.plistPath)) {
      try {
        unlinkSync(this.plistPath);
      } catch (err) {
        return { success: false, error: `Failed to remove plist: ${(err as Error).message}` };
      }
    }

    return { success: true };
  }

  async start(): Promise<ServiceResult> {
    try {
      await execAsync(`launchctl load "${this.plistPath}"`);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async stop(): Promise<ServiceResult> {
    try {
      await execAsync(`launchctl unload "${this.plistPath}"`);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async restart(): Promise<ServiceResult> {
    await this.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return this.start();
  }

  getLogPaths(): { stdout: string; stderr: string } {
    const logDir = join(getTestableHomedir(), 'Library', 'Logs', '247-agent');
    return {
      stdout: join(logDir, 'agent.log'),
      stderr: join(logDir, 'agent.error.log'),
    };
  }

  private generatePlist(options: {
    label: string;
    nodePath: string;
    agentScript: string;
    workingDirectory: string;
    stdoutPath: string;
    stderrPath: string;
    runAtLoad: boolean;
    keepAlive: boolean;
    isDev: boolean;
    configPath: string;
    /** Port the agent must listen on; left out when no configuration could be loaded */
    port?: number;
  }): string {
    const portEntry =
      options.port === undefined
        ? ''
        : `
        <key>AGENT_247_PORT</key>
        <string>${escapeXml(String(options.port))}</string>`;

    let programArgs: string;
    if (options.isDev) {
      programArgs = `        <string>/usr/bin/env</string>
        <string>npx</string>
        <string>tsx</string>
        <string>${escapeXml(options.agentScript)}</string>`;
    } else {
      programArgs = `        <string>${escapeXml(options.nodePath)}</string>
        <string>${escapeXml(options.agentScript)}</string>`;
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(options.label)}</string>

    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>

    <key>WorkingDirectory</key>
    <string>${escapeXml(options.workingDirectory)}</string>

    <key>RunAtLoad</key>
    <${options.runAtLoad}/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>

    <key>StandardOutPath</key>
    <string>${escapeXml(options.stdoutPath)}</string>

    <key>StandardErrorPath</key>
    <string>${escapeXml(options.stderrPath)}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>AGENT_247_CONFIG</key>
        <string>${escapeXml(options.configPath)}</string>${portEntry}
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>ProcessType</key>
    <string>Interactive</string>

    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>`;
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
