import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIGRATIONS_DIR,
  readBotServiceFetchers,
  readEnvConfig,
  readNodeHostSettings,
} from "./config";

const REQUIRED = {
  DEPLOYMENT_NAME: "test",
  GITHUB_BOT_USERNAME: "bot[bot]",
  TOKEN_ENCRYPTION_KEY: "k1",
  PROVIDER_ACCOUNTS_ENCRYPTION_KEY: "k2",
  REPO_SECRETS_ENCRYPTION_KEY: "k3",
};

describe("readEnvConfig", () => {
  it("passes Docker settings through to the host without accepting a transport from env", () => {
    const docker = {
      SANDBOX_PROVIDER: "docker",
      DOCKER_SOCKET_PATH: "/run/docker.sock",
      DOCKER_SANDBOX_IMAGE: "sandbox:local",
      DOCKER_SANDBOX_NETWORK: "sandboxes",
      DOCKER_CONTROL_PLANE_URL: "http://app:8787",
      DOCKER_PORTAL_PORT: "8791",
      DOCKER_PORTAL_BASE_DOMAIN: "portals.example.com",
      DOCKER_PORTAL_PUBLIC_PORT: "443",
      DOCKER_PORTAL_SCHEME: "https",
    };
    expect(readEnvConfig({ ...REQUIRED, ...docker, DOCKER_TRANSPORT: "not-a-capability" })).toEqual(
      { ...REQUIRED, ...docker }
    );
  });
  it("takes host-independent config and ignores Worker-only settings and other variables", () => {
    const config = readEnvConfig({
      ...REQUIRED,
      LOG_LEVEL: "debug",
      SANDBOX_PROVIDER: "e2b",
      SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS: "60000",
      SESSION_DO_LOCATION_HINT: "wnam",
      PATH: "/usr/bin",
      DATA_DIR: "/var/lib/oi",
    });
    expect(config).toEqual({
      ...REQUIRED,
      LOG_LEVEL: "debug",
      SANDBOX_PROVIDER: "e2b",
      SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS: "60000",
    });
  });

  it("treats an empty variable as unset", () => {
    const config = readEnvConfig({ ...REQUIRED, LOG_LEVEL: "" });
    expect("LOG_LEVEL" in config).toBe(false);
  });

  it("rejects invalid teams enforcement modes at startup", () => {
    expect(() => readEnvConfig({ ...REQUIRED, TEAMS_ENFORCEMENT: "enabled" })).toThrow(
      "Invalid TEAMS_ENFORCEMENT"
    );
  });

  it("rejects an unknown default model at startup", () => {
    expect(() => readEnvConfig({ ...REQUIRED, DEFAULT_MODEL: "acme/not-a-model" })).toThrow(
      'DEFAULT_MODEL "acme/not-a-model" is not a model in the catalog'
    );
    expect(readEnvConfig({ ...REQUIRED, DEFAULT_MODEL: "openai/gpt-5.5" }).DEFAULT_MODEL).toBe(
      "openai/gpt-5.5"
    );
  });

  it("names every missing required variable at once", () => {
    expect(() => readEnvConfig({ DEPLOYMENT_NAME: "test", TOKEN_ENCRYPTION_KEY: "" })).toThrow(
      "Missing required configuration: GITHUB_BOT_USERNAME, TOKEN_ENCRYPTION_KEY, PROVIDER_ACCOUNTS_ENCRYPTION_KEY, REPO_SECRETS_ENCRYPTION_KEY"
    );
  });
});

describe("readNodeHostSettings", () => {
  it("requires DATA_DIR and defaults the rest", () => {
    expect(() => readNodeHostSettings({})).toThrow("DATA_DIR is required");
    const settings = readNodeHostSettings({ DATA_DIR: "/var/lib/oi" });
    expect(settings).toEqual({
      host: "0.0.0.0",
      port: 8787,
      dataDir: "/var/lib/oi",
      migrationsDir: DEFAULT_MIGRATIONS_DIR,
      shutdownTimeoutMs: 30_000,
    });
    expect(DEFAULT_MIGRATIONS_DIR.endsWith("/terraform/d1/migrations")).toBe(true);
  });

  it("reads the overrides and rejects a malformed number", () => {
    const settings = readNodeHostSettings({
      DATA_DIR: "data",
      HOST: "127.0.0.1",
      PORT: "9000",
      MIGRATIONS_DIR: "/srv/migrations",
      SHUTDOWN_TIMEOUT_MS: "5000",
    });
    expect(settings.host).toBe("127.0.0.1");
    expect(settings.port).toBe(9000);
    expect(settings.dataDir).toBe(`${process.cwd()}/data`);
    expect(settings.migrationsDir).toBe("/srv/migrations");
    expect(settings.shutdownTimeoutMs).toBe(5000);
    expect(() => readNodeHostSettings({ DATA_DIR: "data", PORT: "80a" })).toThrow(
      "PORT must be a non-negative integer, got 80a"
    );
  });
});

describe("readBotServiceFetchers", () => {
  it("leaves both bots unbound when nothing is set", () => {
    expect(readBotServiceFetchers({ SLACK_BOT_URL: "" })).toEqual({
      SLACK_BOT: undefined,
      LINEAR_BOT: undefined,
    });
  });

  it("binds each configured bot", () => {
    const fetchers = readBotServiceFetchers({ LINEAR_BOT_URL: "http://linear-bot:8080" });
    expect(fetchers.SLACK_BOT).toBeUndefined();
    expect(fetchers.LINEAR_BOT).toBeDefined();
  });

  it("rejects a URL that is not absolute http(s)", () => {
    for (const url of ["slack-bot:8080", "/slack"]) {
      expect(() => readBotServiceFetchers({ SLACK_BOT_URL: url })).toThrow(
        "SLACK_BOT_URL must be an absolute http(s) URL"
      );
    }
  });
});
