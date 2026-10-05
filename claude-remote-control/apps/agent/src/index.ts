import { createServer } from './server.js';
import { config } from './config.js';
import { resolveAuthToken } from './lib/auth.js';
import { logger } from './logger.js';

const DEFAULT_PORT = 4678;
const LOOPBACK_HOST = '127.0.0.1';
const ALL_INTERFACES_HOST = '0.0.0.0';
const MAX_PORT = 65535;

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= MAX_PORT ? port : undefined;
}

const PORT = parsePort(process.env.AGENT_247_PORT) ?? config.agent?.port ?? DEFAULT_PORT;

// Listen on loopback unless told otherwise: tunnels (Tailscale, Cloudflare)
// connect locally, and the agent must not be reachable from the LAN by default.
// Containers have to listen on all interfaces to be reachable at all.
const HOST =
  process.env.AGENT_247_BIND_HOST ||
  config.agent?.host ||
  (process.env.CLOUD_AGENT === 'true' ? ALL_INTERFACES_HOST : LOOPBACK_HOST);

// Hook scripts running inside the sessions post back to this port
process.env.AGENT_247_PORT = String(PORT);

// Hook scripts must authenticate to the agent like any other client. Export
// the effective token so each tmux session inherits it (terminal.ts spawns
// with the agent's environment) and notify-247.sh can send it.
const effectiveToken = resolveAuthToken(config.agent?.authToken, process.env.AGENT_247_AUTH_TOKEN);
if (effectiveToken) {
  process.env.AGENT_247_TOKEN = effectiveToken;
}

process.on('unhandledRejection', (reason) => {
  logger.main.error({ err: reason }, 'Unhandled promise rejection');
});

async function main() {
  logger.main.info({ machine: config.machine.name }, 'Starting 247 Agent');

  const server = await createServer();

  server.on('error', (err) => {
    logger.main.error({ err, host: HOST, port: PORT }, 'Agent server failed');
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    logger.main.info({ host: HOST, port: PORT }, 'Agent running');
    logger.main.info({ url: `ws://localhost:${PORT}` }, 'Dashboard connection URL');
    logger.main.info({ url: `http://localhost:${PORT}/pair` }, 'Pair with dashboard at');
    logger.main.info('For remote access, use Tailscale Funnel, Cloudflare Tunnel, or SSH tunnel');
    if (HOST !== LOOPBACK_HOST) {
      logger.main.warn(
        { host: HOST },
        'Listening beyond loopback: anyone who can reach this port can open a terminal'
      );
    }
  });
}

main().catch((err) => {
  logger.main.error(err, 'Agent startup failed');
  process.exit(1);
});
