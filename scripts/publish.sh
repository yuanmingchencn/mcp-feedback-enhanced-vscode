#!/bin/bash
#
# One-click publish script for MCP Feedback Enhanced
# Publishes: MCP server (npm) + VSCode extension (Open VSX) + local install
#
# Usage:
#   ./scripts/publish.sh [patch|minor|major]
#   Default: patch
#
# Tokens are read from .env.publish:
#   NPM_TOKEN=npm_xxx
#   OVSX_TOKEN=ovsxat_xxx
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_DIR="$ROOT_DIR/mcp-server"
ENV_FILE="$ROOT_DIR/.env.publish"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${GREEN}[✓]${NC} $1"; }
warn()    { echo -e "${YELLOW}[!]${NC} $1"; }
error()   { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step()    { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

# Parse version bump type (default: patch)
BUMP_TYPE="${1:-patch}"
if [[ "$BUMP_TYPE" != "patch" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "major" ]]; then
    error "Invalid bump type: $BUMP_TYPE (use patch, minor, or major)"
fi

# ─── Load tokens ────────────────────────────────────────────────────────
step "Loading tokens"

if [[ ! -f "$ENV_FILE" ]]; then
    error ".env.publish not found. Create it with:\n  NPM_TOKEN=npm_xxx\n  OVSX_TOKEN=ovsxat_xxx"
fi

# Source env file (supports KEY=VALUE format)
set -a
source "$ENV_FILE"
set +a

[[ -z "$NPM_TOKEN" ]] && error "NPM_TOKEN not set in .env.publish"
[[ -z "$OVSX_TOKEN" ]] && error "OVSX_TOKEN not set in .env.publish"
info "Tokens loaded"

# ─── Pre-flight checks ─────────────────────────────────────────────────
step "Pre-flight checks"

npx vsce --version > /dev/null 2>&1 || error "vsce not available. Run: npm install -g @vscode/vsce"
npx ovsx --version > /dev/null 2>&1 || error "ovsx not available. Run: npm install -g ovsx"

if [[ -n "$(git status --porcelain)" ]]; then
    warn "Working directory has uncommitted changes"
fi
info "All checks passed"

# ─── Bump version ──────────────────────────────────────────────────────
step "Bumping version ($BUMP_TYPE)"

cd "$ROOT_DIR"
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)")
NEW_VERSION=$(node -e "
    const v = '$CURRENT_VERSION'.split('.').map(Number);
    if ('$BUMP_TYPE' === 'major') { v[0]++; v[1]=0; v[2]=0; }
    else if ('$BUMP_TYPE' === 'minor') { v[1]++; v[2]=0; }
    else { v[2]++; }
    console.log(v.join('.'));
")

# Update both package.json files
node -e "
    const fs = require('fs');
    ['package.json', 'mcp-server/package.json'].forEach(f => {
        const pkg = JSON.parse(fs.readFileSync(f, 'utf8'));
        pkg.version = '$NEW_VERSION';
        fs.writeFileSync(f, JSON.stringify(pkg, null, 2) + '\n');
    });
"
info "$CURRENT_VERSION → $NEW_VERSION"

# ─── Build ─────────────────────────────────────────────────────────────
step "Building"
npm run compile 2>&1 | tail -1
info "Build complete"

# ─── Publish MCP server to npm ─────────────────────────────────────────
step "Publishing to npm"

cd "$MCP_DIR"
echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc
npm publish 2>&1 | grep -E '^\+|^npm notice (name|version|filename)' || true
NPM_EXIT=${PIPESTATUS[0]}
rm -f .npmrc

if [[ $NPM_EXIT -ne 0 ]]; then
    error "npm publish failed"
fi
info "npm: mcp-feedback-enhanced@$NEW_VERSION"

# ─── Package VSIX ──────────────────────────────────────────────────────
step "Packaging VSIX"

cd "$ROOT_DIR"
npx vsce package 2>&1 | tail -1
VSIX_FILE="mcp-feedback-enhanced-${NEW_VERSION}.vsix"
[[ ! -f "$VSIX_FILE" ]] && error "VSIX not found: $VSIX_FILE"
info "VSIX: $VSIX_FILE"

# ─── Publish to Open VSX ───────────────────────────────────────────────
step "Publishing to Open VSX"

npx ovsx publish "$VSIX_FILE" -p "$OVSX_TOKEN" 2>&1 | tail -3
info "Open VSX: mcp-feedback-enhanced@$NEW_VERSION"

# ─── Install locally ───────────────────────────────────────────────────
step "Installing locally"

if command -v cursor &> /dev/null; then
    cursor --install-extension "$VSIX_FILE" --force 2>&1 | tail -1
    info "Local install complete"
else
    warn "cursor CLI not found, skipping local install"
fi

# ─── Done ──────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Published mcp-feedback-enhanced@${NEW_VERSION}      ║${NC}"
echo -e "${GREEN}║                                              ║${NC}"
echo -e "${GREEN}║  ✓ npm registry                              ║${NC}"
echo -e "${GREEN}║  ✓ Open VSX                                  ║${NC}"
echo -e "${GREEN}║  ✓ Local VSIX install                        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
info "Reload Cursor window to activate"
