import { SandboxProviderError } from "./provider";

/** How long a start may wait in the queue for a running slot. */
export const DOCKER_ADMISSION_WAIT_MS = 60_000;
/** Starts allowed to wait at once; any more are refused immediately. */
export const DOCKER_ADMISSION_QUEUE_LIMIT = 8;
const DOCKER_ADMISSION_POLL_MS = 2_000;

/**
 * Host-wide gate in front of every Docker sandbox start. One per Node host:
 * each session runtime builds its own provider, so the gate cannot live there.
 */
export interface DockerAdmission {
  admit<T>(start: () => Promise<T>): Promise<T>;
}

export interface DockerAdmissionOptions {
  maxRunning: number;
  minFreeDiskPercent: number;
  /** Running session containers, from the Engine. */
  countRunning(): Promise<number>;
  /** Free space on the host's data directory, 0-100. */
  freeDiskPercent(): Promise<number>;
  waitMs?: number;
  queueLimit?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class SandboxAdmissionRefusedError extends SandboxProviderError {
  constructor(message: string) {
    // Transient: refusal says nothing about the next attempt, so it must not
    // trip the spawn circuit breaker.
    super(message, "transient");
    this.name = "SandboxAdmissionRefusedError";
  }
}

/**
 * Serializes check-then-start so two starts cannot both see the last slot.
 * Starts wait FIFO, up to `queueLimit` of them for `waitMs` each, then refuse.
 * ponytail: in-process lock, assumes the documented single Node host process.
 */
export function createDockerAdmission(options: DockerAdmissionOptions): DockerAdmission {
  const waitMs = options.waitMs ?? DOCKER_ADMISSION_WAIT_MS;
  const queueLimit = options.queueLimit ?? DOCKER_ADMISSION_QUEUE_LIMIT;
  const pollMs = options.pollMs ?? DOCKER_ADMISSION_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let tail: Promise<void> = Promise.resolve();
  let queued = 0;

  return {
    async admit(start) {
      if (queued >= queueLimit) {
        throw new SandboxAdmissionRefusedError(
          "Sandbox host is at capacity and its start queue is full; try again shortly"
        );
      }
      queued++;
      const deadline = now() + waitMs;
      const previous = tail;
      let release!: () => void;
      tail = new Promise((resolve) => (release = resolve));
      try {
        await previous;
        const free = await options.freeDiskPercent();
        if (free < options.minFreeDiskPercent) {
          throw new SandboxAdmissionRefusedError(
            `Sandbox host disk is nearly full (${Math.floor(free)}% free); no new sandboxes start until space is freed`
          );
        }
        while ((await options.countRunning()) >= options.maxRunning) {
          if (now() >= deadline) {
            throw new SandboxAdmissionRefusedError(
              `Sandbox host is at capacity (${options.maxRunning} running); try again when another session goes idle`
            );
          }
          await sleep(pollMs);
        }
        return await start();
      } finally {
        queued--;
        release();
      }
    },
  };
}
