#!/usr/bin/env bash
set -euo pipefail

# Set up and build the Phoenix asset pipeline (Tailwind + esbuild).
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root/web"
mix assets.setup
mix assets.build
