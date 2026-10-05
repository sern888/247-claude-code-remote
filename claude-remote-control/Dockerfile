# 247 Agent Dockerfile
# Runs the agent server with terminal support via tmux

FROM node:22-slim

# Install tmux and other dependencies
RUN apt-get update && apt-get install -y \
    tmux \
    git \
    curl \
    bash \
    && rm -rf /var/lib/apt/lists/*

# Use the pnpm version pinned in package.json ("packageManager")
RUN corepack enable

# Create app directory
WORKDIR /app

# Copy package files (tsconfig.json is extended by the agent and shared packages)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY apps/agent/package.json ./apps/agent/
COPY packages/shared/package.json ./packages/shared/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY apps/agent/ ./apps/agent/
COPY packages/shared/ ./packages/shared/

# Build
RUN pnpm build

# Create data directory for SQLite
RUN mkdir -p /root/.247/data && chmod +x /app/apps/agent/docker-entrypoint.sh

# CLOUD_AGENT makes the agent listen on all interfaces (required inside a
# container) and disables self-update via npm.
ENV CLOUD_AGENT=true

# Expose port
EXPOSE 4678

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:4678/health || exit 1

# Start agent (the entrypoint writes a default config on first start)
WORKDIR /app/apps/agent
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
