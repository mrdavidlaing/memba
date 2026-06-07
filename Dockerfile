# syntax=docker/dockerfile:1

ARG ELIXIR_VERSION=1.18.4
ARG OTP_VERSION=27
ARG DEBIAN_VERSION=bookworm
ARG BUILDER_IMAGE="elixir:${ELIXIR_VERSION}-otp-${OTP_VERSION}-slim"
ARG RUNNER_IMAGE="debian:${DEBIAN_VERSION}-slim"

FROM ${BUILDER_IMAGE} AS dev

ARG USERNAME=vscode
ARG USER_UID=1000
ARG USER_GID=${USER_UID}
ARG ADRGEN_VERSION=v0.4.1-beta
ARG ARGC_VERSION=v1.24.0
ARG ESBUILD_VERSION=0.27.2
ARG NODE_VERSION=v22.22.2
ARG TAILWIND_VERSION=4.2.4

# sshx — pinned by immutable S3 object version (corresponds to the v0.4.1 release)
ARG SSHX_VERSION=0.4.1
ARG SSHX_S3_VERSION_ID=XkaG41E86MM6KJLn5mogsBf3H54zuvmG
ARG SSHX_SHA256=faa53abd902f4391acbcba696c55052cd6553534bd4907305d4caca192430ef2
ARG ZELLIJ_VERSION=0.44.3
ARG ZELLIJ_SHA256=0f7c346788627f506c0a28296517768633cff24fc822a739f8264b640ecad751

# ───────────────────────────────────────────────────────────────────────────
# Layer 1 — base OS, locale, certs, fonts, user, language runtimes
# ───────────────────────────────────────────────────────────────────────────
RUN apt-get update -y && apt-get install -y \
    bash \
    build-essential \
    ca-certificates \
    curl \
    fontconfig \
    git \
    git-lfs \
    inotify-tools \
    locales \
    postgresql-client \
    python3 \
    sudo \
    xz-utils \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
    && locale-gen \
    && groupadd --gid "${USER_GID}" "${USERNAME}" \
    && useradd --uid "${USER_UID}" --gid "${USER_GID}" -m "${USERNAME}" \
    && echo "${USERNAME} ALL=(root) NOPASSWD:ALL" > "/etc/sudoers.d/${USERNAME}" \
    && chmod 0440 "/etc/sudoers.d/${USERNAME}"

# Node runtime (Elixir/OTP are provided by the base image)
RUN curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 \
    && node --version \
    && npm --version

# ───────────────────────────────────────────────────────────────────────────
# Layer 2 — generic dev-time tooling (project-agnostic CLIs)
# ───────────────────────────────────────────────────────────────────────────
RUN curl -fsSL "https://raw.githubusercontent.com/sigoden/argc/main/install.sh" | sh -s -- --tag "${ARGC_VERSION}" --to /usr/local/bin || \
    echo "⚠️  WARNING: Failed to install argc from GitHub. This tool will not be available."

RUN curl -fsSL "https://github.com/asiermarques/adrgen/releases/download/${ADRGEN_VERSION}/adrgen_Linux_x86_64.tar.gz" \
    | tar -xz -C /tmp \
    && install -m 0755 /tmp/adrgen /usr/local/bin/adrgen \
    && rm -f /tmp/adrgen

RUN curl -L https://fly.io/install.sh | sh \
    && install -m 0755 /root/.fly/bin/flyctl /usr/local/bin/flyctl \
    && ln -sf /usr/local/bin/flyctl /usr/local/bin/fly || \
    echo "⚠️  WARNING: Failed to install Fly CLI. This tool will not be available."

# sshx (collaborative terminal) — deconstructed from the upstream
# `curl https://sshx.io/get | sh` one-liner so the binary is version-pinned to an
# immutable S3 object version and checksum-verified instead of "always latest".
RUN curl -fsSL "https://s3.amazonaws.com/sshx/sshx-x86_64-unknown-linux-musl.tar.gz?versionId=${SSHX_S3_VERSION_ID}" -o /tmp/sshx.tar.gz \
    && echo "${SSHX_SHA256}  /tmp/sshx.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/sshx.tar.gz -C /tmp sshx \
    && install -m 0755 /tmp/sshx /usr/local/bin/sshx \
    && rm -f /tmp/sshx.tar.gz /tmp/sshx \
    && sshx --version

RUN curl -fsSL "https://github.com/zellij-org/zellij/releases/download/v${ZELLIJ_VERSION}/zellij-x86_64-unknown-linux-musl.tar.gz" -o /tmp/zellij.tar.gz \
    && echo "${ZELLIJ_SHA256}  /tmp/zellij.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/zellij.tar.gz -C /tmp zellij \
    && install -m 0755 /tmp/zellij /usr/local/bin/zellij \
    && rm -f /tmp/zellij.tar.gz /tmp/zellij \
    && zellij --version

# Coding agent CLIs — installed here rather than as a devcontainer Feature.
# Installed without version pinning because these tools evolve quickly.
RUN npm install -g \
    "@anthropic-ai/claude-code@latest" \
    "@openai/codex@latest" \
    "opencode-ai@latest" \
    "@earendil-works/pi-coding-agent@latest"

# ───────────────────────────────────────────────────────────────────────────
# Layer 3 — Phoenix asset pipeline (app-specific build tooling)
# ───────────────────────────────────────────────────────────────────────────
RUN curl -fsSL "https://github.com/tailwindlabs/tailwindcss/releases/download/v${TAILWIND_VERSION}/tailwindcss-linux-x64" \
    -o /usr/local/bin/tailwindcss \
    && chmod 0755 /usr/local/bin/tailwindcss \
    && tailwindcss --help >/dev/null

RUN npm install -g "esbuild@${ESBUILD_VERSION}"

# ───────────────────────────────────────────────────────────────────────────
# Image-invariant environment — the single source of truth for these values.
# Do NOT duplicate these in docker-compose.yml or devcontainer.json.
# ───────────────────────────────────────────────────────────────────────────
ENV LANG=C.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=C.UTF-8 \
    ELIXIR_ERL_OPTIONS=+fnu \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    HEX_CACERTS_PATH=/etc/ssl/certs/ca-certificates.crt \
    FONTCONFIG_PATH=/etc/fonts \
    FONTCONFIG_FILE=/etc/fonts/fonts.conf \
    NODE_PATH=/usr/local/lib/node_modules \
    MIX_ESBUILD_PATH=/usr/local/bin/esbuild \
    MIX_TAILWIND_PATH=/usr/local/bin/tailwindcss

SHELL ["/bin/bash", "-c"]

WORKDIR /workspaces/memba

FROM ${BUILDER_IMAGE} AS builder

RUN apt-get update -y && apt-get install -y build-essential git \
    && apt-get clean && rm -f /var/lib/apt/lists/*_*

WORKDIR /app

RUN mix local.hex --force && mix local.rebar --force

ENV MIX_ENV=prod

COPY web/mix.exs web/mix.lock ./
RUN mix deps.get --only $MIX_ENV
RUN mkdir config

COPY web/config/config.exs web/config/${MIX_ENV}.exs config/
RUN mix deps.compile

COPY web/priv priv
COPY web/lib lib
COPY web/assets assets

RUN mix compile
RUN mix assets.deploy

COPY web/config/runtime.exs config/
COPY web/rel rel
RUN mix release

FROM ${RUNNER_IMAGE} AS runner

RUN apt-get update -y && apt-get install -y libstdc++6 openssl libncurses5 locales ca-certificates \
    && apt-get clean && rm -f /var/lib/apt/lists/*_*

RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen

ENV LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8 \
    MIX_ENV=prod

WORKDIR /app
RUN chown nobody /app

COPY --from=builder --chown=nobody:root /app/_build/prod/rel/memba ./

USER nobody

CMD ["/app/bin/server"]
