#!/usr/bin/env bash
set -euo pipefail

# Install the Elixir build tools (Hex + rebar3) and fetch the Phoenix app's deps.
# Runs in onCreate (a prebuild-captured hook) so it completes before
# build-web-assets, which runs in updateContent and needs the dependencies.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mix local.hex --force
mix local.rebar --force
cd "$repo_root/web"
mix deps.get
