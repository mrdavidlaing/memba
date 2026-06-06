#!/usr/bin/env bash
set -euo pipefail

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found; install the Node devcontainer Feature before agent-clis." >&2
  exit 1
fi

echo "Installing coding-agent CLIs..."
npm install -g \
  @anthropic-ai/claude-code@2.1.162 \
  @openai/codex@0.137.0 \
  opencode-ai@1.15.13
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.78.1
