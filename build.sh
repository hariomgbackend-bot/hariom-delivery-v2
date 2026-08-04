#!/usr/bin/env bash
set -e

# Skip headless-browser download for rank tracking (Chromium not needed on server)
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# zxing-cpp: pure Python wheel, no system library needed (unlike pyzbar)
pip install zxing-cpp Pillow --break-system-packages 2>/dev/null || \
pip install zxing-cpp Pillow

# Node deps
npm install

# GBPilot (gbp-server) — build its dist so server.js can import it
cd gbp-server && npm ci && npm run build && cd ..
