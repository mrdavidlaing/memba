const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  assetBuildStep,
  buildLifecycleConfig,
  buildMixCommand,
  buildPostgresReadinessCommand,
  createBrowserAcceptanceLifecycle,
  databaseSetupSteps
} = require("../features/support/lifecycle");

function testEnv(overrides = {}) {
  return {
    PATH: process.env.PATH,
    ACCEPTANCE_PORT: "4444",
    MEMBA_POSTGRES_PORT: "15555",
    ...overrides
  };
}

test("lifecycle prepares Postgres, database, Phoenix, readiness, and teardown in a dev shell", async () => {
  const calls = [];
  const env = testEnv({ MEMBA_DEVENV_SHELL: "1" });
  const lifecycle = createBrowserAcceptanceLifecycle({
    env,
    processRunner: {
      async run(spec, { label }) {
        calls.push({ type: "run", label, spec });
      },
      async start(spec, { label }) {
        calls.push({ type: "start", label, spec });

        return {
          exitStatus: () => null,
          async stop() {
            calls.push({ type: "stop", label });
          }
        };
      }
    },
    async httpReady(url) {
      calls.push({ type: "httpReady", url });
      return { statusCode: 200 };
    }
  });

  await lifecycle.start();
  await lifecycle.stop();

  assert.equal(lifecycle.baseUrl, "http://lvh.me:4444");
  assert.deepEqual(
    calls.map((call) => `${call.type}:${call.label || call.url}`),
    [
      "run:Postgres readiness",
      ...databaseSetupSteps.map((step) => `run:Database setup: ${step.label}`),
      `run:Asset setup: ${assetBuildStep.label}`,
      "start:Phoenix server",
      "httpReady:http://lvh.me:4444",
      "stop:Phoenix server"
    ]
  );
});

test("Postgres readiness uses devenv processes instead of removed bin/dev postgres", async () => {
  const config = await buildLifecycleConfig(testEnv());
  const command = buildPostgresReadinessCommand(config);

  assert.equal(command.command, "bash");
  assert.equal(command.args[0], "-lc");
  assert.match(command.args[1], /processes status postgres/);
  assert.match(command.args[1], /devenv -O services\.postgres\.port:int "\$MEMBA_POSTGRES_PORT" processes up --no-strict-ports -d postgres/);
  assert.match(command.args[1], /devenv -O services\.postgres\.port:int "\$MEMBA_POSTGRES_PORT" processes wait --timeout 120/);
  assert.doesNotMatch(command.args[1], /bin\/dev postgres/);
  assert.equal(command.env.MEMBA_POSTGRES_PORT, "15555");
});

test("native devcontainer readiness waits for the configured Postgres service", async () => {
  const config = await buildLifecycleConfig(testEnv({ MEMBA_NATIVE_DEVCONTAINER: "1" }));
  const command = buildPostgresReadinessCommand(config);

  assert.equal(command.command, "bash");
  assert.equal(command.args[0], "-lc");
  assert.match(command.args[1], /pg_isready/);
  assert.doesNotMatch(command.args[1], /devenv/);
  assert.equal(command.env.MEMBA_POSTGRES_PORT, "15555");
});

test("non-dev-shell mix commands run through devenv on the selected Postgres port", async () => {
  const config = await buildLifecycleConfig(testEnv());
  const command = buildMixCommand(config, ["ecto.create", "--quiet"]);

  assert.equal(command.command, "devenv");
  assert.deepEqual(command.args.slice(0, 6), [
    "shell",
    "-O",
    "services.postgres.port:int",
    "15555",
    "--",
    path.resolve(__dirname, "../../bin/mix")
  ]);
  assert.deepEqual(command.args.slice(6), ["ecto.create", "--quiet"]);
  assert.equal(command.env.MIX_ENV, "test");
  assert.equal(command.env.PHX_SERVER, "true");
  assert.equal(command.env.PORT, "4444");
  assert.equal(command.env.MEMBA_POSTGRES_PORT, "15555");
});

test("native devcontainer mix commands run directly through bin/mix", async () => {
  const config = await buildLifecycleConfig(testEnv({ MEMBA_NATIVE_DEVCONTAINER: "1" }));
  const command = buildMixCommand(config, ["ecto.create", "--quiet"]);

  assert.equal(command.command, path.resolve(__dirname, "../../bin/mix"));
  assert.deepEqual(command.args, ["ecto.create", "--quiet"]);
  assert.equal(command.env.MIX_ENV, "test");
  assert.equal(command.env.PHX_SERVER, "true");
  assert.equal(command.env.PORT, "4444");
  assert.equal(command.env.MEMBA_POSTGRES_PORT, "15555");
});

test("readiness timeout reports Phoenix startup/readiness diagnostics", async () => {
  const env = testEnv({
    MEMBA_DEVENV_SHELL: "1",
    ACCEPTANCE_HTTP_READY_TIMEOUT_MS: "0"
  });
  const lifecycle = createBrowserAcceptanceLifecycle({
    env,
    processRunner: {
      async run() {},
      async start() {
        return {
          exitStatus: () => null,
          async stop() {}
        };
      }
    },
    async httpReady() {
      throw new Error("connection refused");
    },
    async delay() {}
  });

  await assert.rejects(
    () => lifecycle.start(),
    /Phoenix startup\/readiness failed: timed out after 0ms/
  );
});

test("database setup failures report database setup diagnostics", async () => {
  const env = testEnv({ MEMBA_DEVENV_SHELL: "1" });
  const lifecycle = createBrowserAcceptanceLifecycle({
    env,
    processRunner: {
      async run(_spec, { label }) {
        if (label === "Database setup: migrate test database") {
          throw new Error("migration failed");
        }
      },
      async start() {
        throw new Error("Phoenix should not start after database setup failure");
      }
    },
    async httpReady() {
      return { statusCode: 200 };
    }
  });

  await assert.rejects(
    () => lifecycle.start(),
    /Database setup failed while migrate test database\.\nCause: migration failed/
  );
});


test("asset setup failures report asset setup diagnostics", async () => {
  const env = testEnv({ MEMBA_DEVENV_SHELL: "1" });
  const lifecycle = createBrowserAcceptanceLifecycle({
    env,
    processRunner: {
      async run(_spec, { label }) {
        if (label === "Asset setup: build browser assets") {
          throw new Error("asset build failed");
        }
      },
      async start() {
        throw new Error("Phoenix should not start after asset setup failure");
      }
    },
    async httpReady() {
      return { statusCode: 200 };
    }
  });

  await assert.rejects(
    () => lifecycle.start(),
    /Asset setup failed while build browser assets\.\nCause: asset build failed/
  );
});
