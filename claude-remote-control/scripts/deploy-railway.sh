#!/bin/bash
set -euo pipefail

# 247 Agent - Railway Deployment Script
# Usage: ./scripts/deploy-railway.sh

echo "Deploying 247 Agent to Railway..."
echo ""

# The agent has no authentication. Deploying it behind a public URL gives a
# shell in the container (and ANTHROPIC_API_KEY) to anyone who finds that URL.
if [ "${ALLOW_PUBLIC_AGENT:-}" != "1" ]; then
    echo "Refusing to deploy: 'railway domain' publishes the agent on a public URL"
    echo "and the agent has no authentication. Anyone who learns the URL can open a"
    echo "terminal in the container and read its secrets."
    echo ""
    echo "Keep the service on Railway's private network, or re-run with"
    echo "ALLOW_PUBLIC_AGENT=1 if you accept the risk."
    exit 1
fi

# Check railway CLI is installed
if ! command -v railway &> /dev/null; then
    echo "Error: railway CLI not found."
    echo "Install with: npm install -g @railway/cli"
    exit 1
fi

# Check if logged in
if ! railway whoami &> /dev/null; then
    echo "Please login to Railway..."
    railway login
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# Initialize Railway project if needed
if [ ! -f "railway.json" ] && [ ! -f ".railway/config.json" ]; then
    echo "Initializing Railway project..."
    railway init
fi

# Create railway.json for config
if [ ! -f "railway.json" ]; then
    echo "Creating railway.json..."
    cat > railway.json << 'EOF'
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "healthcheckPath": "/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5
  }
}
EOF
fi

# Deploy
echo "Deploying..."
railway up --detach

# Set environment variables if available
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    echo "Setting ANTHROPIC_API_KEY..."
    railway variables set ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
else
    echo ""
    echo "Note: ANTHROPIC_API_KEY not set in environment."
    echo "Set it with: railway variables set ANTHROPIC_API_KEY=your-key"
fi

# Get domain
echo ""
echo "Getting deployment URL..."
DOMAIN=$(railway domain 2>/dev/null || echo "")

echo ""
echo "Deployment complete!"
echo ""
if [ -n "$DOMAIN" ]; then
    echo "Your agent is available at:"
    echo "  https://$DOMAIN"
else
    echo "To get a public URL, run:"
    echo "  railway domain"
fi
echo ""
echo "To view logs:"
echo "  railway logs"
echo ""
echo "To open Railway dashboard:"
echo "  railway open"
