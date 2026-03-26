#!/usr/bin/env bash
# Builds the Astro docs site and copies the output into the gateway's public/ directory.
# Usage: ./scripts/sync-docs.sh [path-to-docs]
#
# Examples:
#   ./scripts/sync-docs.sh                          # uses default sibling path
#   ./scripts/sync-docs.sh /path/to/mspMarketPlace/msp-claude-plugins/docs
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default: assume the docs live in the sibling monorepo checkout
DOCS_DIR="${1:-$GATEWAY_ROOT/../mspMarketPlace/msp-claude-plugins/docs}"

if [ ! -d "$DOCS_DIR" ]; then
  echo "ERROR: Docs directory not found at $DOCS_DIR"
  echo "Pass the path as an argument: ./scripts/sync-docs.sh /path/to/docs"
  exit 1
fi

echo "Building docs from $DOCS_DIR (gateway target) ..."
(cd "$DOCS_DIR" && npm ci && SITE_URL=https://mcp.wyretechnology.com BASE_PATH=/ npm run build)

echo "Copying build output to $GATEWAY_ROOT/public/ ..."
rm -rf "$GATEWAY_ROOT/public"
cp -r "$DOCS_DIR/dist" "$GATEWAY_ROOT/public"

# Fix robots.txt sitemap URL for the gateway domain
sed -i '' 's|https://wyre-technology.github.io/msp-claude-plugins/|https://mcp.wyretechnology.com/|g' "$GATEWAY_ROOT/public/robots.txt"

echo "Done. $(find "$GATEWAY_ROOT/public" -type f | wc -l | tr -d ' ') files in public/"
