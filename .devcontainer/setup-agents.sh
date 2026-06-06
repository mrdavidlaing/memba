#!/usr/bin/env bash
set -euo pipefail

if [ -z "${OPENCODE_API_KEY:-}" ]; then
  cat >&2 <<'EOF'

!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
!! OPENCODE_API_KEY is not set.
!! Agent config files will still be written, but Claude Code, OpenCode, and Pi
!! cannot authenticate until the Codespaces secret or container environment is
!! fixed.
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

EOF
fi

ZEN_BASE="https://opencode.ai/zen"

# ---------------------------------------------------------------------------
# 1. Claude Code  (CLI + VS Code extension)  ->  Zen /messages
#    Claude Code applies this file's "env" block to its own process, so both
#    the terminal `claude` and the extension authenticate with no sign-in.
# ---------------------------------------------------------------------------
mkdir -p "$HOME/.claude"
cat > "$HOME/.claude/settings.json" <<EOF
{
  "env": {
    "ANTHROPIC_BASE_URL": "${ZEN_BASE}",
    "ANTHROPIC_AUTH_TOKEN": "${OPENCODE_API_KEY:-}",
    "ANTHROPIC_MODEL": "claude-opus-4-8",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5"
  }
}
EOF
chmod 600 "$HOME/.claude/settings.json"

# ---------------------------------------------------------------------------
# 2. Codex CLI  ->  Zen /responses
#    env_key points at OPENCODE_API_KEY; Codex reads it at runtime and sends it
#    as a Bearer token, so the key is NOT embedded in this file.
#    wire_api MUST be "responses" (Codex dropped Chat Completions in Feb 2026).
# ---------------------------------------------------------------------------
mkdir -p "$HOME/.codex"
cat > "$HOME/.codex/config.toml" <<'EOF'
model = "gpt-5.5"
model_provider = "zen"

[model_providers.zen]
name = "OpenCode Zen"
base_url = "https://opencode.ai/zen/v1"
env_key = "OPENCODE_API_KEY"
wire_api = "responses"
requires_openai_auth = false
EOF

# ---------------------------------------------------------------------------
# 3. OpenCode  ->  Zen native
#    Nothing to write: OpenCode authenticates to Zen automatically from the
#    OPENCODE_API_KEY environment variable. Students pick a model with /models
#    (or set a default in the repo's opencode.json, e.g. "opencode/claude-opus-4-8").
# ---------------------------------------------------------------------------
echo "OpenCode: authenticated via OPENCODE_API_KEY (no config needed)."

# ---------------------------------------------------------------------------
# 4. Pi  ->  Zen OpenAI-compatible /chat/completions
#    Provider definition in models.json; credential in auth.json (literal key).
# ---------------------------------------------------------------------------
mkdir -p "$HOME/.pi/agent"

cat > "$HOME/.pi/agent/models.json" <<'EOF'
{
  "providers": {
    "zen": {
      "name": "OpenCode Zen",
      "baseUrl": "https://opencode.ai/zen/v1",
      "api": "openai-completions",
      "models": [
        { "id": "gpt-5.5" },
        { "id": "claude-opus-4-8" },
        { "id": "gemini-3.1-pro" }
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

echo "All four agents wired to OpenCode Zen."

# ===========================================================================
# VERIFY ONCE BEFORE ROLLING OUT TO A CLASS
#
# A) Auth header (affects Claude Code, Codex, Pi). This assumes Zen accepts the
#    key as a Bearer token. Test:
#
#      curl https://opencode.ai/zen/v1/messages \
#        -H "Authorization: Bearer $OPENCODE_API_KEY" \
#        -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
#        -d '{"model":"claude-opus-4-8","max_tokens":16,
#             "messages":[{"role":"user","content":"hi"}]}'
#
#    Completion = Bearer works. 401 = Zen wants "x-api-key" instead; then in
#    section 1 use ANTHROPIC_API_KEY instead of ANTHROPIC_AUTH_TOKEN.
#
# B) Base-URL form. Each tool appends its own path to the base
#    (Claude Code -> /v1/messages, Codex -> /responses, Pi -> /chat/completions).
#    If you get 404s, the base needs adjusting for that tool.
#
# C) Pi model reach. Pi here uses Zen's OpenAI-compatible endpoint. Confirm
#    which model IDs actually answer through it by running `pi` then `/models`
#    (Zen's per-model native endpoints differ; the compatible endpoint may not
#    expose every model). Trim the models.json list to whatever responds.
# ===========================================================================
