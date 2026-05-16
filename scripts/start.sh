#!/bin/bash
# ============================================================================
# illoo WhatsApp Service — Simple start script
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(dirname "$SCRIPT_DIR")"

echo "Starting illoo WhatsApp Service..."
echo "Service directory: $SERVICE_DIR"

# Check .env exists
if [ ! -f "$SERVICE_DIR/.env" ]; then
  echo ""
  echo "ERROR: .env file not found at $SERVICE_DIR/.env"
  echo "Copy .env.example and configure it first:"
  echo "  cp $SERVICE_DIR/.env.example $SERVICE_DIR/.env"
  echo "  nano $SERVICE_DIR/.env"
  echo ""
  exit 1
fi

# Check node_modules
if [ ! -d "$SERVICE_DIR/node_modules" ]; then
  echo "node_modules not found. Running npm install..."
  cd "$SERVICE_DIR" && npm install --production
fi

echo "Starting Node.js process..."
cd "$SERVICE_DIR"
node src/index.js
