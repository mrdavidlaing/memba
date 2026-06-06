#!/usr/bin/env bash
set -euo pipefail

# Wire ONLY the OpenCode-Zen agents (OpenCode + Pi) to the shared Zen key.
#
# Claude Code and Codex are intentionally NOT configured here: developers
# authenticate them interactively against their own Anthropic / ChatGPT
# accounts (OAuth) the first time they launch each tool in a new codespace
# (`claude` then /login, and `codex login`). Writing no config for them is
# what lets their normal OAuth sign-in flow run.

ZEN_BASE="https://opencode.ai/zen"

if [ -z "${OPENCODE_API_KEY:-}" ]; then
  cat >&2 <<'EOF'

!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
!! OPENCODE_API_KEY is not set.
!! OpenCode and Pi cannot authenticate to OpenCode Zen until the Codespaces
!! secret (or container environment) provides it.
!! (Claude Code and Codex are unaffected — they use your own OAuth login.)
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

EOF
fi

# ---------------------------------------------------------------------------
# OpenCode  ->  Zen native
#   Nothing to write: OpenCode authenticates to Zen automatically from the
#   OPENCODE_API_KEY environment variable. Pick a model with /models (or set a
#   default in the repo's opencode.json, e.g. "opencode/claude-opus-4-8").
# ---------------------------------------------------------------------------
echo "OpenCode: authenticated via OPENCODE_API_KEY (no config needed)."

# ---------------------------------------------------------------------------
# Pi  ->  Zen OpenAI-compatible /chat/completions
#   Provider definition in models.json; credential in auth.json (literal key).
# ---------------------------------------------------------------------------
mkdir -p "$HOME/.pi/agent"

cat > "$HOME/.pi/agent/models.json" <<EOF
{
  "providers": {
    "zen": {
      "name": "OpenCode Zen",
      "baseUrl": "${ZEN_BASE}/v1",
      "api": "openai-completions",
      "models": [
        { "id": "qwen3.7-plus" },
        { "id": "kimi-k2.6" },
        { "id": "deepseek-v4-flash-free" }
      ]
    }
  }
}
EOF

cat > "$HOME/.pi/agent/auth.json" <<EOF
{
  "zen": { "type": "api_key", "key": "${OPENCODE_API_KEY:-}" }
}
EOF
chmod 600 "$HOME/.pi/agent/auth.json"

echo "OpenCode and Pi wired to OpenCode Zen."
echo "Claude Code and Codex use your own accounts: run 'claude' then /login, and 'codex login', to sign in via OAuth."
