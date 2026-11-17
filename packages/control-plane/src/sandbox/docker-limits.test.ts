import { describe, expect, it } from "vitest";
import { resolveDockerSandboxLimits } from "./docker-limits";

describe("resolveDockerSandboxLimits", () => {
  it("defaults to three 2 GiB, 1 CPU sandboxes without swap or a custom runtime", () => {
    expect(resolveDockerSandboxLimits({})).toEqual({
      memoryBytes: 2048 * 1024 * 1024,
      memorySwapBytes: 2048 * 1024 * 1024,
      nanoCpus: 1e9,
      pidsLimit: 2048,
      runtime: undefined,
      dns: [],
      maxRunning: 3,
      minFreeDiskPercent: 10,
      stoppedRetentionMs: 14 * 24 * 60 * 60 * 1000,
    });
  });

  it("reads overrides, adding swap on top of memory", () => {
    expect(
      resolveDockerSandboxLimits({
        DOCKER_SANDBOX_MEMORY_MB: "1024",
        DOCKER_SANDBOX_SWAP_MB: "512",
        DOCKER_SANDBOX_CPUS: "0.5",
        DOCKER_SANDBOX_PIDS_LIMIT: "512",
        DOCKER_SANDBOX_RUNTIME: "runsc",
        DOCKER_SANDBOX_DNS: "10.0.0.1, 10.0.0.2",
        DOCKER_SANDBOX_MAX_RUNNING: "4",
      })
    ).toMatchObject({
      memoryBytes: 1024 * 1024 * 1024,
      memorySwapBytes: 1536 * 1024 * 1024,
      nanoCpus: 5e8,
      pidsLimit: 512,
      runtime: "runsc",
      dns: ["10.0.0.1", "10.0.0.2"],
      maxRunning: 4,
    });
  });

  it("treats an empty DOCKER_SANDBOX_DNS as unset", () => {
    expect(resolveDockerSandboxLimits({ DOCKER_SANDBOX_DNS: " , " }).dns).toEqual([]);
  });

  it.each([
    ["DOCKER_SANDBOX_MEMORY_MB", "2g"],
    ["DOCKER_SANDBOX_CPUS", "0"],
    ["DOCKER_SANDBOX_PIDS_LIMIT", "1.5"],
    ["DOCKER_SANDBOX_MAX_RUNNING", "0"],
    ["DOCKER_SANDBOX_MIN_FREE_DISK_PERCENT", "100"],
    ["DOCKER_SANDBOX_RUNTIME", "runsc --debug"],
    ["DOCKER_SANDBOX_DNS", "example.com"],
    ["DOCKER_SANDBOX_DNS", "10.0.0.256"],
    ["DOCKER_SANDBOX_DNS", "10.0.0.1,::1"],
  ])("rejects %s=%s", (name, value) => {
    expect(() => resolveDockerSandboxLimits({ [name]: value })).toThrow(name);
  });
});
