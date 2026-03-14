#!/usr/bin/env bash
# Install Python deps for barcode decoding
pip3 install pyzbar Pillow --break-system-packages || pip install pyzbar Pillow

# Install system lib that pyzbar needs
apt-get install -y libzbar0 2>/dev/null || true

# Install Node deps
npm install
