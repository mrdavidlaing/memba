const { spawn } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../../..");
const binDevPath = path.join(repoRoot, "bin", "dev");
const binMixPath = path.join(repoRoot, "bin", "mix");

const databaseSetupSteps = [
  { label: "drop existing test database", mixArgs: ["ecto.drop", "--quiet"] },
  { label: "create test database", mixArgs: ["ecto.create", "--quiet"] },
  { label: "create event store", mixArgs: ["event_store.create", "--quiet"] },
  { label: "migrate test database", mixArgs: ["ecto.migrate", "--quiet"] },
  { label: "initialize event store", mixArgs: ["event_store.init", "--quiet"] }
];
const assetBuildStep = { label: "build browser assets", mixArgs: ["assets.build"] };

class LogBuffer {
  constructor(limit = 30000) {
    this.limit = limit;
    this.value = "";
  }

  append(source, chunk) {
    const text = String(chunk);
    if (text.length === 0) {
      return;
    }

    const prefixed = text
      .split(/\r?\n/)
      .map((line) => (line.length > 0 ? `[${source}] ${line}` : `[${source}]`))
      .join("\n");

    this.value = `${this.value}${prefixed}\n`;

    if (this.value.length > this.limit) {
      this.value = this.value.slice(this.value.length - this.limit);
    }
  }

  tail() {
    return this.value.trimEnd();
  }
}

function buildCommandEnvironment(config) {
  return {
    ...config.env,
    MIX_ENV: "test",
    PHX_SERVER: "true",
    PORT: String(config.phoenixPort),
    MEMBA_POSTGRES_PORT: String(config.postgresPort),
    MEMBA_ACCEPTANCE_LOCAL_EMAIL: "true"
  };
}

function buildDevCommand(config, subcommand) {
  return {
    command: config.binDevPath,
    args: [subcommand],
    cwd: config.repoRoot,
    env: buildCommandEnvironment(config)
  };
}

function buildPostgresReadinessCommand(config) {
  if (config.usesNativeServices) {
    return {
      command: "bash",
      args: [
        "-lc",
        'host="${PGHOST:-localhost}"; port="${PGPORT:-$MEMBA_POSTGRES_PORT}"; for i in $(seq 1 120); do pg_isready -h "$host" -p "$port" >/dev/null 2>&1 && exit 0; sleep 1; done; echo "Postgres did not become ready at PGHOST=$host PGPORT=$port" >&2; exit 1'
      ],
      cwd: config.repoRoot,
      env: buildCommandEnvironment(config)
    };
  }

  return {
    command: "bash",
    args: [
      "-lc",
      'if ! devenv -O services.postgres.port:int "$MEMBA_POSTGRES_PORT" processes status postgres >/dev/null 2>&1; then DEVENV_TUI=false devenv -O services.postgres.port:int "$MEMBA_POSTGRES_PORT" processes up --no-strict-ports -d postgres; fi; devenv -O services.postgres.port:int "$MEMBA_POSTGRES_PORT" processes wait --timeout 120'
    ],
    cwd: config.repoRoot,
    env: buildCommandEnvironment(config)
  };
}

function buildMixCommand(config, mixArgs) {
  const env = buildCommandEnvironment(config);

  if (config.inDevShell || config.usesNativeServices) {
    return {
      command: config.binMixPath,
      args: mixArgs,
      cwd: config.repoRoot,
      env
    };
  }

  return {
    command: "devenv",
    args: [
      "shell",
      "-O",
      "services.postgres.port:int",
      String(config.postgresPort),
      "--",
      config.binMixPath,
      ...mixArgs
    ],
    cwd: config.repoRoot,
    env
  };
}

function buildPhoenixCommand(config) {
  return buildMixCommand(config, ["phx.server"]);
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function parseBoolean(value) {
  return value === "1" || value === "true" || value === "yes";
}

async function buildLifecycleConfig(env = process.env, portFinder = findFreePort) {
  const phoenixPort = env.ACCEPTANCE_PORT || env.PORT || (await portFinder());
  let postgresPort = env.MEMBA_POSTGRES_PORT || env.PGPORT || (await portFinder());

  if (String(postgresPort) === String(phoenixPort)) {
    postgresPort = await portFinder();
  }

  const baseUrl = env.BASE_URL || `http://lvh.me:${phoenixPort}`;

  return {
    env,
    repoRoot,
    binDevPath,
    binMixPath,
    baseUrl,
    phoenixPort,
    postgresPort,
    inDevShell: env.MEMBA_DEVENV_SHELL === "1",
    usesNativeServices: env.MEMBA_NATIVE_DEVCONTAINER === "1" || env.MEMBA_USE_DEVENV === "0",
    skipAppStart: parseBoolean(env.ACCEPTANCE_SKIP_APP_START),
    tearDownPostgres:
      !parseBoolean(env.ACCEPTANCE_KEEP_POSTGRES) &&
      (parseBoolean(env.ACCEPTANCE_MANAGE_POSTGRES) || env.MEMBA_DEVENV_SHELL !== "1"),
    commandTimeoutMs: Number(env.ACCEPTANCE_COMMAND_TIMEOUT_MS || 300000),
    httpReadyTimeoutMs: Number(env.ACCEPTANCE_HTTP_READY_TIMEOUT_MS || 60000),
    shutdownTimeoutMs: Number(env.ACCEPTANCE_SHUTDOWN_TIMEOUT_MS || 60000)
  };
}

function commandLine(spec) {
  return [spec.command, ...spec.args].join(" ");
}

function killProcessGroup(child, signal) {
  if (!child || !child.pid) {
    return;
  }

  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (_error) {
    // The process may already have exited.
  }
}

function runCommand(spec, { label, timeoutMs, logBuffer }) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    let killTimeout = null;

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, "SIGTERM");
      killTimeout = setTimeout(() => {
        killProcessGroup(child, "SIGKILL");
      }, 5000);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      logBuffer.append(label, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      logBuffer.append(label, chunk);
    });

    child.once("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      reject(
        new Error(
          `${label} failed to start.\nCommand: ${commandLine(spec)}\nError: ${error.message}`
        )
      );
    });

    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimeout);

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const reason = timedOut
        ? `timed out after ${timeoutMs}ms`
        : `exited with code ${code}${signal ? ` and signal ${signal}` : ""}`;

      reject(
        new Error(
          `${label} failed: ${reason}.\nCommand: ${commandLine(spec)}\nRecent output:\n${
            logBuffer.tail() || "(no output captured)"
          }`
        )
      );
    });
  });
}

function startManagedProcess(spec, { label, logBuffer, shutdownTimeoutMs }) {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });

  let exitStatus = null;

  child.stdout.on("data", (chunk) => logBuffer.append(label, chunk));
  child.stderr.on("data", (chunk) => logBuffer.append(label, chunk));
  child.once("error", (error) => {
    exitStatus = { error };
    logBuffer.append(label, `failed to start: ${error.message}`);
  });

  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exitStatus = { code, signal };
      resolve(exitStatus);
    });
  });

  return {
    command: commandLine(spec),
    exitStatus: () => exitStatus,
    async stop() {
      if (exitStatus) {
        return;
      }

      killProcessGroup(child, "SIGTERM");

      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), shutdownTimeoutMs))
      ]);

      if (!stopped) {
        killProcessGroup(child, "SIGKILL");
        await exited;
      }
    }
  };
}

function checkHttpReady(url, requestTimeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.get(parsed, (response) => {
      response.resume();
      resolve({ statusCode: response.statusCode });
    });

    request.setTimeout(requestTimeoutMs, () => {
      request.destroy(new Error(`HTTP readiness request timed out after ${requestTimeoutMs}ms`));
    });

    request.once("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createBrowserAcceptanceLifecycle(options = {}) {
  const env = options.env || process.env;
  const logBuffer = options.logBuffer || new LogBuffer();
  const processRunner = options.processRunner || {
    run: runCommand,
    start: startManagedProcess
  };
  const portFinder = options.portFinder || findFreePort;
  const httpReady = options.httpReady || checkHttpReady;
  const wait = options.delay || delay;

  let config = null;
  let phoenixProcess = null;

  async function ensureConfig() {
    if (!config) {
      config = await buildLifecycleConfig(env, portFinder);
    }

    return config;
  }

  async function stopPhoenix() {
    if (!phoenixProcess) {
      return;
    }

    await phoenixProcess.stop();
    phoenixProcess = null;
  }

  async function tearDownPostgres() {
    const currentConfig = await ensureConfig();

    if (!currentConfig.tearDownPostgres) {
      return;
    }

    await processRunner.run(buildDevCommand(currentConfig, "down"), {
      label: "Postgres teardown",
      timeoutMs: currentConfig.shutdownTimeoutMs,
      logBuffer
    });
  }

  async function waitForPhoenixReadiness(currentConfig) {
    const deadline = Date.now() + currentConfig.httpReadyTimeoutMs;
    let lastError = null;

    while (Date.now() <= deadline) {
      const exitStatus = phoenixProcess && phoenixProcess.exitStatus();

      if (exitStatus) {
        throw new Error(
          `Phoenix startup/readiness failed: server exited before ${currentConfig.baseUrl} became ready.\n` +
            `Exit status: ${JSON.stringify(exitStatus)}\nRecent output:\n${
              logBuffer.tail() || "(no output captured)"
            }`
        );
      }

      try {
        const response = await httpReady(currentConfig.baseUrl);

        if (response.statusCode && response.statusCode < 500) {
          return;
        }

        lastError = new Error(`HTTP ${response.statusCode}`);
      } catch (error) {
        lastError = error;
      }

      await wait(250);
    }

    throw new Error(
      `Phoenix startup/readiness failed: timed out after ${currentConfig.httpReadyTimeoutMs}ms waiting for ` +
        `${currentConfig.baseUrl}.\nLast readiness error: ${
          lastError ? lastError.message : "(none)"
        }\nRecent output:\n${logBuffer.tail() || "(no output captured)"}`
    );
  }

  return {
    get baseUrl() {
      return config ? config.baseUrl : env.BASE_URL || "http://lvh.me:4000";
    },

    getLogTail() {
      return logBuffer.tail();
    },

    async start() {
      const currentConfig = await ensureConfig();

      if (currentConfig.skipAppStart) {
        logBuffer.append("lifecycle", `Using external browser acceptance app at ${currentConfig.baseUrl}`);
        return;
      }

      try {
        await processRunner.run(buildPostgresReadinessCommand(currentConfig), {
          label: "Postgres readiness",
          timeoutMs: currentConfig.commandTimeoutMs,
          logBuffer
        });

        for (const step of databaseSetupSteps) {
          try {
            await processRunner.run(buildMixCommand(currentConfig, step.mixArgs), {
              label: `Database setup: ${step.label}`,
              timeoutMs: currentConfig.commandTimeoutMs,
              logBuffer
            });
          } catch (error) {
            throw new Error(`Database setup failed while ${step.label}.\nCause: ${error.message}`, {
              cause: error
            });
          }
        }

        try {
          await processRunner.run(buildMixCommand(currentConfig, assetBuildStep.mixArgs), {
            label: `Asset setup: ${assetBuildStep.label}`,
            timeoutMs: currentConfig.commandTimeoutMs,
            logBuffer
          });
        } catch (error) {
          throw new Error(`Asset setup failed while ${assetBuildStep.label}.
Cause: ${error.message}`, {
            cause: error
          });
        }

        phoenixProcess = await processRunner.start(buildPhoenixCommand(currentConfig), {
          label: "Phoenix server",
          logBuffer,
          shutdownTimeoutMs: currentConfig.shutdownTimeoutMs
        });

        await waitForPhoenixReadiness(currentConfig);
      } catch (error) {
        await stopPhoenix();
        await tearDownPostgres().catch((teardownError) => {
          logBuffer.append("Postgres teardown", teardownError.message);
        });
        throw error;
      }
    },

    async stop() {
      await stopPhoenix();
      await tearDownPostgres();
    }
  };
}

module.exports = {
  LogBuffer,
  assetBuildStep,
  buildDevCommand,
  buildLifecycleConfig,
  buildMixCommand,
  buildPhoenixCommand,
  buildPostgresReadinessCommand,
  createBrowserAcceptanceLifecycle,
  databaseSetupSteps,
  findFreePort
};
