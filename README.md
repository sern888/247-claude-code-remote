# 247 - Remote Terminal Access for Claude Code

**Access Claude Code from anywhere - phone, tablet, or any browser. Run AI-assisted coding sessions 24/7 without being tied to your desk.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

<p align="center">
  <img src="./demo.gif" alt="247 Demo" width="700" />
</p>

## Why 247?

Ever wanted to check on your Claude Code session from your phone? Or start a quick coding task from a tablet while away from your desk? **247** makes it possible.

- **Mobile-first**: Fully responsive web terminal with touch scroll support
- **Always accessible**: Access your dev machine from any browser, anywhere
- **Session persistence**: Leave and come back - your sessions stay alive via tmux
- **No port forwarding**: reach the agent through a tunnel (Tailscale or Cloudflare) — see [Security](#security)
- **PWA ready**: Install as an app on your phone for instant access

## Features

| Feature                     | Description                                  |
| --------------------------- | -------------------------------------------- |
| **Web Terminal**            | Full xterm.js terminal with canvas rendering |
| **Claude Code Integration** | One-click launch of Claude Code sessions     |
| **Multi-Project Support**   | Switch between projects from the dashboard   |
| **Session Management**      | Persistent tmux sessions survive disconnects |
| **Real-time Sync**          | WebSocket-based instant communication        |
| **Mobile Optimized**        | Touch gestures, virtual keyboard support     |
| **Dark/Light Mode**         | Automatic theme detection                    |
| **Installable PWA**         | Add to home screen, push notifications       |

## Quick Start

### Prerequisites

- **Node.js 22+**
- **tmux** installed (`brew install tmux` on macOS)
- **Tailscale or Cloudflare Tunnel** (optional, for remote access)

### Installation

```bash
# Clone the repository
git clone https://github.com/QuivrHQ/247.git
cd 247/claude-remote-control

# Install dependencies
pnpm install

# Start development servers
pnpm dev
```

This starts:

- **Web Dashboard**: http://localhost:3001
- **Agent**: ws://localhost:4678

### Using the CLI

```bash
# Install globally
npm install -g 247-cli

# Initialize configuration
247 init

# Start the agent
247 start

# Check status
247 status
```

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │        Your Phone / Tablet          │
                    │         247.quivr.com               │
                    └──────────────┬──────────────────────┘
                                   │ HTTPS
                    ┌──────────────▼──────────────────────┐
                    │         Cloudflare Tunnel           │
                    └──────────────┬──────────────────────┘
                                   │ WebSocket
┌──────────────────────────────────▼──────────────────────────────────────┐
│                            Your Mac                                      │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                         247 Agent                                   │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │ │
│  │  │   Express   │  │  WebSocket  │  │   node-pty  │                 │ │
│  │  │   Server    │──│   Handler   │──│   + tmux    │                 │ │
│  │  └─────────────┘  └─────────────┘  └──────┬──────┘                 │ │
│  │                                            │                        │ │
│  │                                    ┌───────▼───────┐                │ │
│  │                                    │  Claude Code  │                │ │
│  │                                    └───────────────┘                │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
247/
├── apps/
│   ├── web/          # Next.js 16 dashboard (deployed to Vercel)
│   └── agent/        # Node.js agent (runs on your machine)
├── packages/
│   ├── cli/          # CLI tool for agent management
│   └── shared/       # Shared TypeScript types
└── scripts/          # Build and release automation
```

## Configuration

The agent reads `~/.247/config.json` (created by `247 init`, or by
`scripts/setup-local.sh` when running from source):

```json
{
  "machine": {
    "id": "a-unique-id",
    "name": "MacBook Pro"
  },
  "agent": {
    "port": 4678,
    "host": "127.0.0.1",
    "allowedOrigins": []
  },
  "projects": {
    "basePath": "~/Dev",
    "whitelist": ["project1", "project2"]
  }
}
```

- `projects.basePath` is the folder whose sub-folders are offered as projects;
  an empty `whitelist` allows all of them.
- `agent.host` is the interface the agent listens on. It defaults to loopback
  (`127.0.0.1`); tunnels connect locally, so this rarely needs changing.
- `agent.allowedOrigins` lists extra dashboard origins (for a self-hosted
  dashboard). `https://247.quivr.com` and `http://localhost:3001` are always
  allowed.

## Security

The agent hands out a terminal on your machine, so treat its address like a
password:

- It listens on loopback only by default and rejects browser requests whose
  `Origin` is not an allowed dashboard, so a web page you merely visit cannot
  talk to it.
- **It requires a bearer token when one is configured.** `247 init` generates
  `agent.authToken` (overridable with `AGENT_247_AUTH_TOKEN`); the agent then
  demands `Authorization: Bearer <token>` on HTTP and a `247.bearer.<token>`
  WebSocket subprotocol on every route except `/health` and pairing, and the
  dashboard receives the token during pairing. A legacy install with no
  `agent.authToken` runs **without** authentication (and logs a warning), so
  anyone who can reach its URL can open a terminal.
- Treat the agent's URL as sensitive regardless. A Tailscale Funnel or a public
  Cloudflare hostname is reachable by the whole internet — prefer tailnet-only
  access (`tailscale serve`) or put Cloudflare Access in front of the hostname.
- The deploy scripts for Fly.io and Railway refuse to publish the agent on a
  public URL unless you set `ALLOW_PUBLIC_AGENT=1`.

## Development Commands

| Command          | Description                   |
| ---------------- | ----------------------------- |
| `pnpm dev`       | Start all development servers |
| `pnpm dev:web`   | Start only the web dashboard  |
| `pnpm dev:agent` | Start only the agent          |
| `pnpm build`     | Build all packages            |
| `pnpm test`      | Run all tests                 |
| `pnpm typecheck` | TypeScript type checking      |
| `pnpm lint`      | Lint all packages             |
| `pnpm release`   | Semantic versioning release   |

## Tech Stack

- **Frontend**: Next.js 16, React 19, Tailwind CSS, xterm.js
- **Backend**: Express, WebSocket (ws), node-pty
- **Database**: SQLite (better-sqlite3) on the agent for sessions; Neon Postgres (Drizzle) on the dashboard for accounts, saved agent connections and push subscriptions
- **Terminal**: tmux for session persistence
- **Build**: pnpm workspaces, Turborepo
- **Deployment**: Vercel (web), Tailscale or Cloudflare Tunnel (agent)

## Roadmap

- [ ] Multi-machine support
- [ ] Session sharing
- [ ] Terminal recording/playback
- [ ] Custom themes
- [ ] Keyboard shortcuts customization

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting a PR.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- [xterm.js](https://xtermjs.org/) - Terminal rendering
- [node-pty](https://github.com/microsoft/node-pty) - PTY handling
- [tmux](https://github.com/tmux/tmux) - Session persistence
- [Claude Code](https://claude.ai/code) - AI coding assistant

---

<p align="center">
  <b>Built by <a href="https://quivr.com">Quivr</a></b> (Y Combinator W24)
</p>

<p align="center">
  <a href="https://247.quivr.com">Website</a> •
  <a href="https://github.com/QuivrHQ/247/issues">Issues</a> •
  <a href="https://twitter.com/quaborr">Twitter</a>
</p>
