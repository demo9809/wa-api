# illoo WhatsApp Service — Deployment Guide

## Overview

This service runs a Node.js WhatsApp automation bot on your Hostinger VPS, exposing a REST API that your PHP site calls to send order notification messages via WhatsApp.

---

## 1. VPS Requirements

| Item | Minimum | Recommended |
|------|---------|-------------|
| OS | Ubuntu 20.04 | Ubuntu 22.04 LTS |
| RAM | 1 GB | 2 GB |
| CPU | 1 vCPU | 2 vCPU |
| Disk | 5 GB free | 10 GB free |
| Port | 3001 (localhost only) | — |

Puppeteer (headless Chromium) is the most memory-intensive part. 2 GB RAM is strongly recommended for stable long-term operation.

---

## 2. Node.js 18+ Installation via nvm

```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# Reload shell
source ~/.bashrc   # or ~/.zshrc

# Install Node 18
nvm install 18
nvm use 18
nvm alias default 18

# Verify
node --version   # should show v18.x.x
npm --version
```

---

## 3. PM2 Installation

```bash
npm install -g pm2

# Verify
pm2 --version
```

---

## 4. Chromium / Puppeteer Dependencies

Install all system libraries required for headless Chromium:

```bash
apt-get update -y
apt-get install -y \
  gconf-service libasound2 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 \
  libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 \
  libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
  libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 \
  libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 \
  libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates \
  fonts-liberation libappindicator1 lsb-release xdg-utils wget \
  chromium-browser --fix-missing
```

---

## 5. Upload the Service

**Option A — SCP from your local machine:**
```bash
scp -r ./whatsapp-service user@YOUR_VPS_IP:/var/www/illoo/
```

**Option B — Git clone on the server:**
```bash
cd /var/www/illoo
git pull origin main   # if whatsapp-service is part of the repo
```

The service should live at: `/var/www/illoo/whatsapp-service/`

---

## 6. Environment Configuration

```bash
cd /var/www/illoo/whatsapp-service

# Copy the example file
cp .env.example .env

# Edit it
nano .env
```

**Variable reference:**

| Variable | Description | Example |
|----------|-------------|---------|
| `PORT` | Port to listen on (localhost only) | `3001` |
| `API_SECRET_KEY` | 64-char random key for API auth | see below |
| `MAX_DAILY_MESSAGES` | Anti-ban daily limit | `150` |
| `MIN_DELAY_MS` | Minimum delay between messages | `4000` |
| `MAX_DELAY_MS` | Maximum delay between messages | `10000` |
| `MAX_RETRIES` | Failed message retry attempts | `3` |
| `TYPING_MIN_MS` | Min typing simulation duration | `1000` |
| `TYPING_MAX_MS` | Max typing simulation duration | `3000` |
| `RECONNECT_DELAY_MS` | Base delay for reconnection | `10000` |
| `MAX_RECONNECT_ATTEMPTS` | Max auto-reconnect tries | `10` |
| `LOG_LEVEL` | Winston log level | `info` |
| `PHP_SITE_URL` | Your site URL | `https://illoo.store` |
| `NODE_ENV` | Environment | `production` |

**Generate a secure API key:**
```bash
openssl rand -hex 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 7. npm Install

```bash
cd /var/www/illoo/whatsapp-service
npm install --production
```

---

## 8. First Run & QR Code Scanning

```bash
# Run directly to see the QR code in terminal
node src/index.js
```

1. A QR code will appear in the terminal
2. Open WhatsApp on your phone
3. Go to **Settings → Linked Devices → Link a Device**
4. Scan the QR code
5. Wait for "WhatsApp client ready" log message
6. Press `Ctrl+C` to stop — the session is saved in `sessions/`

The session is persisted via `LocalAuth`. You will **not** need to scan again after the first time, unless you log out the linked device from your phone.

---

## 9. PM2 Startup

After the QR code has been scanned once:

```bash
cd /var/www/illoo/whatsapp-service

# Start with PM2 using production env
pm2 start ecosystem.config.js --env production

# Save PM2 process list
pm2 save

# Generate and run startup script (copy the output command and run it)
pm2 startup
# Example output: sudo env PATH=... pm2 startup systemd -u ubuntu --hp /home/ubuntu
# Run that exact command as shown
```

**Useful PM2 commands:**

```bash
pm2 status                        # Show all processes
pm2 logs illoo-whatsapp           # Stream logs
pm2 logs illoo-whatsapp --lines 100  # Last 100 lines
pm2 restart illoo-whatsapp        # Restart service
pm2 stop illoo-whatsapp           # Stop service
pm2 monit                         # Live CPU/RAM monitor
```

---

## 10. Firewall Configuration

The WhatsApp service must ONLY be accessible from localhost (PHP runs on the same server).

```bash
# Install ufw if not present
apt-get install -y ufw

# Allow SSH (CRITICAL — do this first or you'll lock yourself out)
ufw allow OpenSSH
ufw allow 22/tcp

# Allow Nginx/Apache for the PHP site
ufw allow 80/tcp
ufw allow 443/tcp

# DO NOT expose port 3001 publicly
# ufw deny 3001/tcp   ← NOT needed; 3001 binds to 127.0.0.1 only

# Enable firewall
ufw enable

# Verify
ufw status verbose
```

---

## 11. Nginx Reverse Proxy (Optional)

If you want to access the WhatsApp admin API from outside (e.g., for debugging), add a location block with HTTPS only:

```nginx
server {
    listen 443 ssl;
    server_name wa.illoo.store;

    ssl_certificate     /etc/letsencrypt/live/wa.illoo.store/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wa.illoo.store/privkey.pem;

    # Only allow your office IP
    allow 203.0.113.0;  # Replace with your IP
    deny all;

    location / {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
```

> **Security note:** For production, keep port 3001 on localhost. PHP calls it internally via cURL. There is no need for a public-facing proxy.

---

## 12. PHP Integration

**Step 1:** Add constants to `/var/www/illoo/config.php`:

```php
// WhatsApp notification service
define('WA_SERVICE_URL', 'http://127.0.0.1:3001');
define('WA_API_KEY',     'YOUR_64_CHAR_API_SECRET_KEY_HERE');
```

**Step 2:** Include the integration file where needed:

```php
require_once __DIR__ . '/includes/whatsapp.php';
```

Or add it to your global bootstrap/header so it's always available.

**Step 3:** Call the helper functions after order placement:

```php
// After a successful order insert:
wa_notify_order_placed($order, $payment_method);

// After updating order status:
wa_notify_status($order, 'shipped', 'EM123456789IN');
wa_notify_status($order, 'delivered');
wa_notify_status($order, 'cancelled');

// Custom message:
wa_send('9876543210', 'Your custom message here.');
```

The `$order` array should contain the same keys as your orders DB row: `mobile`, `parent_name`, `first_name`, `last_name`, `school_name`, `class_name`, `total_amount`, `house_street`, `landmark`, `city`, `state`, `pincode`, `id`, etc.

---

## 13. Testing with curl

Replace `YOUR_API_KEY` with the value in your `.env`.

```bash
# Health check (no auth required)
curl http://127.0.0.1:3001/health

# Service status
curl -H "x-api-key: YOUR_API_KEY" http://127.0.0.1:3001/api/status

# Get QR code (if not yet authenticated)
curl -H "x-api-key: YOUR_API_KEY" http://127.0.0.1:3001/api/qr

# Send a test message
curl -X POST http://127.0.0.1:3001/api/test \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"phone":"9876543210"}'

# Send a raw message
curl -X POST http://127.0.0.1:3001/api/send \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"phone":"9876543210","message":"Hello from illoo!"}'

# Send a template message
curl -X POST http://127.0.0.1:3001/api/send-template \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "9876543210",
    "templateId": "order_placed_cod",
    "orderId": "1234",
    "vars": {
      "parent_name": "Priya Sharma",
      "order_id": "1234",
      "product_name": "Personalised Name Slip",
      "amount": "499",
      "child_name": "Arjun Sharma",
      "school_name": "Delhi Public School",
      "class_name": "Class 3",
      "address": "42 MG Road, Bangalore, Karnataka 560001",
      "dispatch_days": "3-5"
    }
  }'

# List available templates
curl -H "x-api-key: YOUR_API_KEY" http://127.0.0.1:3001/api/templates

# View queue
curl -H "x-api-key: YOUR_API_KEY" http://127.0.0.1:3001/api/queue

# Reconnect WhatsApp
curl -X POST -H "x-api-key: YOUR_API_KEY" http://127.0.0.1:3001/api/reconnect
```

---

## 14. Monitoring

```bash
# Live process monitor (CPU, RAM, restarts)
pm2 monit

# Stream all logs
pm2 logs illoo-whatsapp

# Log file locations
tail -f /var/www/illoo/whatsapp-service/logs/whatsapp-$(date +%Y-%m-%d).log
tail -f /var/www/illoo/whatsapp-service/logs/error-$(date +%Y-%m-%d).log
tail -f /var/www/illoo/whatsapp-service/logs/pm2-out.log
tail -f /var/www/illoo/whatsapp-service/logs/pm2-err.log
```

---

## 15. Troubleshooting

### WhatsApp keeps disconnecting
- This is normal with `whatsapp-web.js`. The service auto-reconnects (up to 10 attempts with exponential backoff).
- If it stops reconnecting, call `POST /api/reconnect` or `pm2 restart illoo-whatsapp`.
- Check logs: `pm2 logs illoo-whatsapp --lines 200`

### QR code not showing
```bash
pm2 logs illoo-whatsapp   # Look for QR generation logs
# Or run directly: node src/index.js
```

### Puppeteer / Chromium crashes
```bash
# Check if dependencies are installed
apt-get install -y chromium-browser

# Check system memory
free -h

# If OOM, reduce max_memory_restart in ecosystem.config.js
# Or upgrade VPS RAM to 2 GB
```

### Messages not sending
1. Check `GET /api/status` — is `isReady: true`?
2. Check daily limit — is `remaining > 0`?
3. Check `GET /api/queue` for failed messages
4. Check logs for error messages

### Session lost after server reboot
- This should NOT happen if PM2 startup was configured properly.
- If it does, you'll need to scan the QR code again.
- The session is stored in `sessions/` — ensure this folder is not deleted.

### PHP cURL errors (Connection refused)
- Ensure the Node.js service is running: `pm2 status`
- Verify it's on the correct port: `netstat -tlnp | grep 3001`
- Check `WA_SERVICE_URL` in config.php matches the actual port

---

## 16. Daily Limits & Anti-Ban Strategy

WhatsApp aggressively bans numbers that send bulk messages, especially new numbers.

| Account Age | Safe Daily Limit |
|-------------|-----------------|
| New (< 1 week) | 20–30 messages |
| 1–4 weeks | 50–80 messages |
| 1–3 months | 100–150 messages |
| 3+ months | 150–200 messages |

The service is configured at **150 messages/day** by default. Start lower if the number is new.

**Timing:** The service adds random 4–10 second delays between messages and simulates typing presence. Do not reduce these delays.

---

## 17. Anti-Ban Checklist

- [ ] Use a dedicated number (not your personal number) for business messaging
- [ ] Use the number regularly for normal WhatsApp conversations before automation
- [ ] Keep daily limits conservative (start at 50, increase gradually over weeks)
- [ ] Never send the same message to 100s of people in one burst
- [ ] Always include personalised content (order ID, customer name, etc.)
- [ ] Keep `MIN_DELAY_MS` at 4000ms minimum — never lower
- [ ] Enable typing simulation (`TYPING_MIN_MS` / `TYPING_MAX_MS`)
- [ ] If you receive a ban: stop immediately, wait 24–48 hours, reduce limits
- [ ] Do not restart the service excessively — each restart triggers re-authentication checks
- [ ] Avoid sending between midnight and 7 AM

---

## 18. Scaling: Multiple Phone Numbers

If you need to send more than 150 messages/day, you can run multiple instances of this service on different ports, each with its own WhatsApp session and phone number.

**Example setup:**

```
Port 3001 → Phone number A (orders 1–500 in a day)
Port 3002 → Phone number B (orders 501–1000 in a day)
```

Steps:
1. Copy the `whatsapp-service/` directory: `cp -r whatsapp-service whatsapp-service-2`
2. Change `PORT=3002` in the second `.env`
3. Change `name: 'illoo-whatsapp-2'` in the second `ecosystem.config.js`
4. Update `sessions/` data path in `src/client.js` to use a unique folder
5. Start the second instance: `pm2 start ecosystem.config.js --env production`
6. In PHP, route orders to different service URLs based on order ID or load balancing

---

## File Structure

```
whatsapp-service/
├── src/
│   ├── index.js        ← Main entry point
│   ├── client.js       ← WhatsApp client manager
│   ├── queue.js        ← In-memory + JSON queue
│   ├── api.js          ← Express REST API
│   ├── auth.js         ← API key middleware
│   ├── templates.js    ← Message templates
│   └── logger.js       ← Winston logger
├── scripts/
│   ├── setup.sh        ← VPS setup script
│   └── start.sh        ← Simple start script
├── logs/               ← Auto-created, log files here
├── sessions/           ← Auto-created, WhatsApp session
├── data/               ← Auto-created, queue persistence
├── .env                ← Your config (never commit this)
├── .env.example        ← Template for .env
├── .gitignore
├── ecosystem.config.js ← PM2 config
├── package.json
└── DEPLOY.md           ← This file
```
