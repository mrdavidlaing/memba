#!/usr/bin/env bash
set -euo pipefail

# Upgrade (or install) the coding agent CLIs to their latest versions on
# every devcontainer start.  We use sudo because the global npm prefix is
# owned by root; the vscode user has passwordless sudo.

echo "Upgrading agentic editors…"
sudo npm install -g \
  "@anthropic-ai/claude-code@latest" \
  "@openai/codex@latest" \
  "opencode-ai@latest" \
  "@earendil-works/pi-coding-agent@latest"
echo "Agentic editors upgraded."
