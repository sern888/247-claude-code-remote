#!/bin/bash
set -euo pipefail

# 247 Agent - Fly.io Deployment Script
# Usage: ./scripts/deploy-flyio.sh [app-name] [region]

APP_NAME="${1:-247-agent}"
REGION="${2:-cdg}"  # Paris by default

# The agent has no authentication. Deploying it behind a public URL gives a
# shell in the container (and ANTHROPIC_API_KEY) to anyone who finds that URL.
if [ "${ALLOW_PUBLIC_AGENT:-}" != "1" ]; then
    echo "Refusing to deploy: this publishes the agent at https://$APP_NAME.fly.dev"
    echo "and the agent has no authentication. Anyone who learns the URL can open a"
    echo "terminal in the container and read its secrets."
    echo ""
    echo "Put it behind a private network (for example a Fly private IP or Tailscale),"
    echo "or re-run with ALLOW_PUBLIC_AGENT=1 if you accept the risk."
    exit 1
fi

echo "Deploying 247 Agent to Fly.io..."
echo "  App: $APP_NAME"
echo "  Region: $REGION"
echo ""

# Check flyctl is installed
if ! command -v flyctl &> /dev/null; then
    echo "Error: flyctl not found."
    echo "Install with: curl -L https://fly.io/install.sh | sh"
    exit 1
fi

# Check if logged in
if ! flyctl auth whoami &> /dev/null; then
    echo "Please login to Fly.io..."
    flyctl auth login
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# Create app if it doesn't exist
if ! flyctl apps list | grep -q "$APP_NAME"; then
    echo "Creating app '$APP_NAME'..."
    flyctl apps create "$APP_NAME" --machines
fi

# Create fly.toml if it doesn't exist
if [ ! -f "fly.toml" ]; then
    echo "Creating fly.toml..."
    cat > fly.toml << EOF
app = "$APP_NAME"
primary_region = "$REGION"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 4678
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[mounts]
  source = "data"
  destination = "/root/.247/data"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
EOF
fi

# Create volume if it doesn't exist
if ! flyctl volumes list -a "$APP_NAME" | grep -q "data"; then
    echo "Creating data volume..."
    flyctl volumes create data --size 1 --region "$REGION" -a "$APP_NAME"
fi

# Deploy
echo "Deploying..."
flyctl deploy -a "$APP_NAME"

# Check if ANTHROPIC_API_KEY is set
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    echo "Setting ANTHROPIC_API_KEY secret..."
    echo "$ANTHROPIC_API_KEY" | flyctl secrets set ANTHROPIC_API_KEY=- -a "$APP_NAME"
else
    echo ""
    echo "Note: ANTHROPIC_API_KEY not set in environment."
    echo "Set it with: flyctl secrets set ANTHROPIC_API_KEY=your-key -a $APP_NAME"
fi

echo ""
echo "Deployment complete!"
echo ""
echo "Your agent is available at:"
echo "  https://$APP_NAME.fly.dev"
echo ""
echo "To view logs:"
echo "  flyctl logs -a $APP_NAME"
echo ""
echo "To SSH into the machine:"
echo "  flyctl ssh console -a $APP_NAME"
