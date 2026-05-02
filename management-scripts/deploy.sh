#!/bin/bash
# deploy.sh — run from worker project root
# Usage: ./deploy.sh [worker-name]
set -euo pipefail

WORKER=${1:-$(basename "$(pwd)")}
SERVER=${WORKERD_SERVER:-"deploy@yourserver"}

echo "→ Building $WORKER..."
wrangler deploy --dry-run --outdir dist

echo "→ Pushing to server..."
cd dist

# Git <2.28 does not support -b; use two-step init for compatibility
git init
git checkout -b main 2>/dev/null || git checkout main

git add worker.js
git commit -m "deploy $(date -u +%Y%m%dT%H%M%SZ)"
git remote add deploy "ssh://${SERVER}:/var/git/${WORKER}.git" 2>/dev/null || true
git push deploy main --force

echo "✔  Deploy triggered"
