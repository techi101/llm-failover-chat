#!/bin/sh
# Write runtime config so the same image can point at any backend via the API_URL env var.
set -e
cat > /usr/share/nginx/html/config.js <<CFG
window.__APP_CONFIG__ = { API_URL: "${API_URL:-http://localhost:8000}" };
CFG
