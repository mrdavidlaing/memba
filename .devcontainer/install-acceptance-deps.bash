#!/usr/bin/env bash
set -euo pipefail

# Install acceptance-test dependencies and the Playwright Chromium browser.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root/acceptance-tests"
npm ci
npx playwright install --with-deps chromium
