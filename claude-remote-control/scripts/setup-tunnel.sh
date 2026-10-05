#!/bin/bash
set -euo pipefail

echo "Setting up Cloudflare Tunnel..."

# Check if cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
    echo "cloudflared not found. Installing via Homebrew..."
    brew install cloudflared
fi

# Check if already logged in
if ! cloudflared tunnel list &> /dev/null; then
    echo "Please login to Cloudflare..."
    cloudflared tunnel login
fi

# Prompt for tunnel name
read -r -p "Enter tunnel name (e.g., mac-mini): " TUNNEL_NAME

# The hostname must be one of YOUR domains in Cloudflare. It is the public
# address of this machine's agent, not the dashboard (247.quivr.com).
read -r -p "Enter the hostname to expose the agent on (e.g., agent.example.com): " AGENT_HOSTNAME
if ! [[ "$AGENT_HOSTNAME" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
    echo "Error: '$AGENT_HOSTNAME' is not a valid hostname."
    exit 1
fi

echo ""
echo "Warning: the agent has no authentication. Anyone who can reach"
echo "https://$AGENT_HOSTNAME will be able to open a terminal on this machine."
echo "Protect the hostname with Cloudflare Access before using it."
read -r -p "Continue? (y/n): " CONFIRM_PUBLIC
if [ "$CONFIRM_PUBLIC" != "y" ]; then
    echo "Aborted."
    exit 1
fi

# Create tunnel
echo "Creating tunnel '$TUNNEL_NAME'..."
cloudflared tunnel create "$TUNNEL_NAME"

# Get tunnel ID
TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')

echo "Tunnel ID: $TUNNEL_ID"

# Create config
CONFIG_DIR="$HOME/.cloudflared"
mkdir -p "$CONFIG_DIR"

cat > "$CONFIG_DIR/config.yml" << EOF
tunnel: $TUNNEL_ID
credentials-file: $CONFIG_DIR/$TUNNEL_ID.json

ingress:
  - hostname: $AGENT_HOSTNAME
    service: http://localhost:4678
  - service: http_status:404
EOF

echo "Config written to $CONFIG_DIR/config.yml"
echo ""

# Prompt for DNS setup
read -r -p "Set up DNS route to $AGENT_HOSTNAME? (y/n): " SETUP_DNS
if [ "$SETUP_DNS" = "y" ]; then
    cloudflared tunnel route dns "$TUNNEL_NAME" "$AGENT_HOSTNAME"
    echo "DNS route created!"
fi

echo ""
echo "Tunnel setup complete!"
echo ""
echo "To run the tunnel manually:"
echo "  cloudflared tunnel run $TUNNEL_NAME"
echo ""
echo "To install as a service (auto-start):"
echo "  sudo cloudflared service install"
echo ""
echo "To test the tunnel:"
echo "  curl https://$AGENT_HOSTNAME/health"
