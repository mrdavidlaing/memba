#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

setup_app() {
  echo "Preparing Phoenix and acceptance-test dependencies..."
  mix local.hex --force
  mix local.rebar --force
  (
    cd web
    mix deps.get
    mix assets.setup
    mix assets.build
    cd ../acceptance-tests
    npm ci
    npx playwright install --with-deps chromium
  )
}

setup_app
