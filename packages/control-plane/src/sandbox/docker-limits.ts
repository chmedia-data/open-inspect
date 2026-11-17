import type { EnvConfig } from "../types";
import { DOCKER_LABELS } from "./docker-portals";

/**
 * Defaults are sized for one 2 vCPU / 8 GiB host (an AWS t3a.large) running
 * three sandboxes beside the control plane: 3 x 2 GiB leaves about 2 GiB for
 * the control plane, Docker and the OS.
 */
export const DEFAULT_DOCKER_SANDBOX_MEMORY_MB = 2048;
export const DEFAULT_DOCKER_SANDBOX_SWAP_MB = 0;
export const DEFAULT_DOCKER_SANDBOX_CPUS = 1;
export const DEFAULT_DOCKER_SANDBOX_PIDS_LIMIT = 2048;
export const DEFAULT_DOCKER_SANDBOX_MAX_RUNNING = 3;
export const DEFAULT_DOCKER_SANDBOX_MIN_FREE_DISK_PERCENT = 10;
export const DEFAULT_DOCKER_SANDBOX_STOPPED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export interface DockerSandboxLimits {
  memoryBytes: number;
  /** Docker's MemorySwap: memory plus swap. */
  memorySwapBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  /** OCI runtime name such as `runsc`; the daemon default when unset. */
  runtime?: string;
  /** Resolver IPv4 addresses for every sandbox; Docker's embedded resolver when empty. */
  dns: string[];
  maxRunning: number;
  minFreeDiskPercent: number;
  stoppedRetentionMs: number;
}

type DockerLimitEnv = Pick<
  EnvConfig,
  | "DOCKER_SANDBOX_MEMORY_MB"
  | "DOCKER_SANDBOX_SWAP_MB"
  | "DOCKER_SANDBOX_CPUS"
  | "DOCKER_SANDBOX_PIDS_LIMIT"
  | "DOCKER_SANDBOX_RUNTIME"
  | "DOCKER_SANDBOX_DNS"
  | "DOCKER_SANDBOX_MAX_RUNNING"
  | "DOCKER_SANDBOX_MIN_FREE_DISK_PERCENT"
  | "DOCKER_SANDBOX_STOPPED_RETENTION_MS"
>;

const MIB = 1024 * 1024;

export function resolveDockerSandboxLimits(env: DockerLimitEnv): DockerSandboxLimits {
  const memoryMb = positive(
    "DOCKER_SANDBOX_MEMORY_MB",
    env.DOCKER_SANDBOX_MEMORY_MB,
    DEFAULT_DOCKER_SANDBOX_MEMORY_MB,
    6
  );
  const swapMb = number(
    "DOCKER_SANDBOX_SWAP_MB",
    env.DOCKER_SANDBOX_SWAP_MB,
    DEFAULT_DOCKER_SANDBOX_SWAP_MB,
    0
  );
  const cpus = number(
    "DOCKER_SANDBOX_CPUS",
    env.DOCKER_SANDBOX_CPUS,
    DEFAULT_DOCKER_SANDBOX_CPUS,
    0.01,
    false
  );
  const runtime = env.DOCKER_SANDBOX_RUNTIME?.trim() || undefined;
  if (runtime && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(runtime)) {
    throw new Error("DOCKER_SANDBOX_RUNTIME must name a runtime registered with the Docker daemon");
  }
  const dns = (env.DOCKER_SANDBOX_DNS ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  if (!dns.every(isIpv4)) {
    throw new Error("DOCKER_SANDBOX_DNS must be a comma-separated list of IPv4 addresses");
  }
  const minFreeDiskPercent = number(
    "DOCKER_SANDBOX_MIN_FREE_DISK_PERCENT",
    env.DOCKER_SANDBOX_MIN_FREE_DISK_PERCENT,
    DEFAULT_DOCKER_SANDBOX_MIN_FREE_DISK_PERCENT,
    0
  );
  if (minFreeDiskPercent >= 100) {
    throw new Error("DOCKER_SANDBOX_MIN_FREE_DISK_PERCENT must be below 100");
  }
  return {
    memoryBytes: memoryMb * MIB,
    memorySwapBytes: (memoryMb + swapMb) * MIB,
    nanoCpus: Math.round(cpus * 1e9),
    pidsLimit: positive(
      "DOCKER_SANDBOX_PIDS_LIMIT",
      env.DOCKER_SANDBOX_PIDS_LIMIT,
      DEFAULT_DOCKER_SANDBOX_PIDS_LIMIT,
      16
    ),
    runtime,
    dns,
    maxRunning: positive(
      "DOCKER_SANDBOX_MAX_RUNNING",
      env.DOCKER_SANDBOX_MAX_RUNNING,
      DEFAULT_DOCKER_SANDBOX_MAX_RUNNING,
      1
    ),
    minFreeDiskPercent,
    stoppedRetentionMs: positive(
      "DOCKER_SANDBOX_STOPPED_RETENTION_MS",
      env.DOCKER_SANDBOX_STOPPED_RETENTION_MS,
      DEFAULT_DOCKER_SANDBOX_STOPPED_RETENTION_MS,
      60_000
    ),
  };
}

function isIpv4(value: string): boolean {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}

function positive(name: string, value: string | undefined, fallback: number, min: number): number {
  return number(name, value, fallback, min, true);
}

function number(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  integer = true
): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${name} must be ${integer ? "an integer" : "a number"} of at least ${min}`);
  }
  return parsed;
}

/** Engine list query for this deployment's session containers. */
export function dockerSessionListPath(deploymentName: string, all: boolean): string {
  const filters = {
    label: [
      `${DOCKER_LABELS.framework}=open-inspect`,
      `${DOCKER_LABELS.deployment}=${deploymentName}`,
      `${DOCKER_LABELS.kind}=session`,
    ],
  };
  return `/containers/json?all=${all}&filters=${encodeURIComponent(JSON.stringify(filters))}`;
}
