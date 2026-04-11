#!/bin/bash
# GSD + Ralph v3 - Unix start script (M5: cross-platform support)
echo ""
echo "  GSD + Ralph v3 - Installing..."
echo ""
cd "$(dirname "$0")"
npm install --no-fund --no-audit 2>/dev/null
if [ $? -ne 0 ]; then
    echo "  Error: npm install failed. Make sure Node.js is installed."
    exit 1
fi
echo ""
echo "  Starting GSD + Ralph..."
echo ""
npm start
