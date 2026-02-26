#!/usr/bin/env bash
set -euo pipefail

# Open Swarm — Setup Script
# Deploys agent configs, registers MCP server, and validates the installation.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="${HOME}/.config/opencode"
AGENTS_DIR="${CONFIG_DIR}/agents"
OPENCODE_JSON="${CONFIG_DIR}/opencode.json"
REPO_JSON="${SCRIPT_DIR}/opencode/opencode.json"
REPO_AGENTS="${SCRIPT_DIR}/opencode/agents"

echo "🐝 Open Swarm — Setup"
echo "━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: Create directories ────────────────────────────────────────
echo "📁 Creating config directories..."
mkdir -p "${AGENTS_DIR}"

# ── Step 2: Copy agent .md files ──────────────────────────────────────
echo "📋 Deploying agent configs to ${AGENTS_DIR}/"
cp "${REPO_AGENTS}"/*.md "${AGENTS_DIR}/"
echo "   Copied $(ls "${REPO_AGENTS}"/*.md | wc -l | tr -d ' ') agent files"

# ── Step 3: Deploy opencode.json ──────────────────────────────────────
if [ -f "${OPENCODE_JSON}" ]; then
  echo "⚠️  Existing opencode.json found — backing up to opencode.json.backup"
  cp "${OPENCODE_JSON}" "${OPENCODE_JSON}.backup"
fi

# Copy and fix prompt paths for global config
echo "📋 Deploying opencode.json..."
cp "${REPO_JSON}" "${OPENCODE_JSON}"

# Update prompt paths: {file:opencode/agents/...} → {file:~/.config/opencode/agents/...}
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' 's|{file:opencode/agents/|{file:~/.config/opencode/agents/|g' "${OPENCODE_JSON}"
else
  sed -i 's|{file:opencode/agents/|{file:~/.config/opencode/agents/|g' "${OPENCODE_JSON}"
fi

# ── Step 4: Register MCP server with MCPU (if mcpu is available) ──────
if command -v mcpu &>/dev/null; then
  echo "🔌 Registering open-swarm MCP server with MCPU..."
  # Check if already registered
  if mcpu list 2>/dev/null | grep -q "open-swarm"; then
    echo "   Already registered"
  else
    mcpu add open-swarm --type http --url http://127.0.0.1:38546/mcp 2>/dev/null || \
      echo "   ⚠️  Could not auto-register. Add manually: mcpu add open-swarm --type http --url http://127.0.0.1:38546/mcp"
  fi
else
  echo "⚠️  MCPU not found. Install with: npm install -g mcpu"
  echo "   Then register: mcpu add open-swarm --type http --url http://127.0.0.1:38546/mcp"
fi

# ── Step 5: Build MCP server (if not already built) ───────────────────
if [ ! -d "${SCRIPT_DIR}/mcp-server/dist" ]; then
  echo "🔨 Building MCP server..."
  (cd "${SCRIPT_DIR}/mcp-server" && npm install --silent && npm run build --silent)
  echo "   Build complete"
else
  echo "✅ MCP server already built"
fi

# ── Step 6: Validate ──────────────────────────────────────────────────
echo ""
echo "🔍 Validating installation..."

ERRORS=0

# Check agents deployed
AGENT_COUNT=$(ls "${AGENTS_DIR}"/*.md 2>/dev/null | wc -l | tr -d ' ')
if [ "${AGENT_COUNT}" -ge 13 ]; then
  echo "   ✅ ${AGENT_COUNT} agent files deployed"
else
  echo "   ❌ Only ${AGENT_COUNT} agent files found (expected 13+)"
  ERRORS=$((ERRORS + 1))
fi

# Check opencode.json exists and has swarm agent
if [ -f "${OPENCODE_JSON}" ]; then
  if python3 -c "
import json, sys
d = json.load(open('${OPENCODE_JSON}'))
agents = d.get('agent', {})
errors = 0
for name in agents:
    if agents[name].get('mode') == 'subagent' and name.startswith(('manager','worker')):
        tools = agents[name].get('tools', {})
        if not (tools.get('swarm_relay') and tools.get('swarm_board')):
            errors += 1
sys.exit(errors)
" 2>/dev/null; then
    echo "   ✅ All agents have swarm_relay + swarm_board access"
  else
    echo "   ❌ Some agents missing MCP tool access"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "   ❌ opencode.json not found at ${OPENCODE_JSON}"
  ERRORS=$((ERRORS + 1))
fi

# Check MCP server build
if [ -f "${SCRIPT_DIR}/mcp-server/dist/index.js" ]; then
  echo "   ✅ MCP server built"
else
  echo "   ❌ MCP server not built"
  ERRORS=$((ERRORS + 1))
fi

# Check opencode installed
if command -v opencode &>/dev/null; then
  echo "   ✅ OpenCode installed ($(opencode --version 2>/dev/null | head -1))"
else
  echo "   ❌ OpenCode not installed — brew install opencode"
  ERRORS=$((ERRORS + 1))
fi

echo ""
if [ "${ERRORS}" -eq 0 ]; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "🎉 Setup complete! To get started:"
  echo ""
  echo "   # Start the MCP server"
  echo "   cd ${SCRIPT_DIR}/mcp-server && npm start &"
  echo ""
  echo "   # Launch the swarm"
  echo "   opencode --agent swarm"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
else
  echo "⚠️  Setup completed with ${ERRORS} warning(s). Review above."
fi
