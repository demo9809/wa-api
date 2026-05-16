#!/bin/bash
# ============================================================================
# illoo WhatsApp Service — VPS Setup Script (Ubuntu 20.04 / 22.04)
# Run as root or with sudo
# ============================================================================

set -e

SERVICE_DIR="/var/www/illoo/whatsapp-service"

echo "=============================================="
echo "  illoo WhatsApp Service — VPS Setup"
echo "=============================================="
echo ""

# ── Step 1: Update system ──────────────────────────────────────────────────
echo "[1/7] Updating system packages..."
apt-get update -y
apt-get upgrade -y

# ── Step 2: Install Node.js 18+ via nvm ───────────────────────────────────
echo "[2/7] Installing Node.js 18 via nvm..."
if [ ! -d "$HOME/.nvm" ]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
fi

# Load nvm in current shell
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1090
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

nvm install 18
nvm use 18
nvm alias default 18

NODE_VERSION=$(node --version)
echo "Node.js installed: $NODE_VERSION"

# ── Step 3: Install PM2 globally ──────────────────────────────────────────
echo "[3/7] Installing PM2..."
npm install -g pm2

PM2_VERSION=$(pm2 --version)
echo "PM2 installed: $PM2_VERSION"

# ── Step 4: Install Chromium / Puppeteer dependencies ─────────────────────
echo "[4/7] Installing Chromium dependencies..."
apt-get install -y \
  gconf-service \
  libasound2 \
  libatk1.0-0 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libexpat1 \
  libfontconfig1 \
  libgcc1 \
  libgconf-2-4 \
  libgdk-pixbuf2.0-0 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libpangocairo-1.0-0 \
  libstdc++6 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxi6 \
  libxrandr2 \
  libxrender1 \
  libxss1 \
  libxtst6 \
  ca-certificates \
  fonts-liberation \
  libappindicator1 \
  lsb-release \
  xdg-utils \
  wget \
  chromium-browser \
  --fix-missing

echo "Chromium dependencies installed."

# ── Step 5: npm install ────────────────────────────────────────────────────
echo "[5/7] Installing Node.js dependencies..."
if [ -d "$SERVICE_DIR" ]; then
  cd "$SERVICE_DIR"
else
  echo "Service directory not found at $SERVICE_DIR"
  echo "Please upload the whatsapp-service folder to $SERVICE_DIR first."
  exit 1
fi

npm install --production

echo "npm dependencies installed."

# ── Step 6: Configure .env ─────────────────────────────────────────────────
echo "[6/7] Configuring environment..."
if [ ! -f "$SERVICE_DIR/.env" ]; then
  cp "$SERVICE_DIR/.env.example" "$SERVICE_DIR/.env"
  echo ""
  echo "  ⚠️  IMPORTANT: Edit your .env file before starting!"
  echo "  Run: nano $SERVICE_DIR/.env"
  echo ""
  echo "  Key settings to update:"
  echo "    API_SECRET_KEY  — Generate with: openssl rand -hex 32"
  echo "    PHP_SITE_URL    — Your site URL (e.g. https://illoo.store)"
  echo "    PORT            — Default 3001 (keep on 127.0.0.1 only)"
  echo ""
else
  echo ".env already exists — skipping copy."
fi

# ── Step 7: Start with PM2 ────────────────────────────────────────────────
echo "[7/7] Starting service with PM2..."
cd "$SERVICE_DIR"
pm2 start ecosystem.config.js --env production

pm2 save

echo ""
echo "Setting up PM2 startup script..."
PM2_STARTUP=$(pm2 startup | tail -1)
echo "Run this command to enable PM2 on system boot:"
echo "  $PM2_STARTUP"
echo ""
echo "=============================================="
echo "  Setup complete!"
echo "=============================================="
echo ""
echo "Next steps:"
echo "  1. Edit your .env: nano $SERVICE_DIR/.env"
echo "  2. Restart service: pm2 restart illoo-whatsapp"
echo "  3. Watch logs: pm2 logs illoo-whatsapp"
echo "  4. Scan QR code when prompted"
echo "  5. Test: curl -H 'x-api-key: YOUR_KEY' http://127.0.0.1:3001/api/status"
echo ""
