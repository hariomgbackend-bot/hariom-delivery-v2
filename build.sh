#!/usr/bin/env bash
set -e

# zxing-cpp: pure Python wheel, no system library needed (unlike pyzbar)
pip install zxing-cpp Pillow --break-system-packages 2>/dev/null || \
pip install zxing-cpp Pillow

# Node deps
npm install
