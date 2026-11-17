import { describe, expect, it, vi } from "vitest";
import { createDockerAdmission, SandboxAdmissionRefusedError } from "./docker-admission";

function setup(overrides: { running?: number[]; freePercent?: number; queueLimit?: number }) {
  let clock = 0;
  const running = [...(overrides.running ?? [0])];
  const countRunning = vi.fn(async () => (running.length > 1 ? running.shift()! : running[0]));
  const admission = createDockerAdmission({
    maxRunning: 2,
    minFreeDiskPercent: 10,
    countRunning,
    freeDiskPercent: async () => overrides.freePercent ?? 50,
    waitMs: 10,
    pollMs: 4,
    queueLimit: overrides.queueLimit,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { admission, countRunning };
}

describe("createDockerAdmission", () => {
  it("starts when a slot is free", async () => {
    const { admission } = setup({ running: [1] });
    await expect(admission.admit(async () => "ok")).resolves.toBe("ok");
  });

  it("waits for a slot, then starts", async () => {
    const { admission, countRunning } = setup({ running: [2, 2, 1] });
    await expect(admission.admit(async () => "ok")).resolves.toBe("ok");
    expect(countRunning).toHaveBeenCalledTimes(3);
  });

  it("refuses with a transient error when no slot frees within the wait", async () => {
    const { admission } = setup({ running: [2] });
    const start = vi.fn();
    const error = await admission.admit(start).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxAdmissionRefusedError);
    expect(error).toMatchObject({ errorType: "transient" });
    expect((error as Error).message).toContain("at capacity (2 running)");
    expect(start).not.toHaveBeenCalled();
  });

  it("refuses below the disk watermark without counting containers", async () => {
    const { admission, countRunning } = setup({ freePercent: 5 });
    await expect(admission.admit(async () => "ok")).rejects.toThrow("disk is nearly full");
    expect(countRunning).not.toHaveBeenCalled();
  });

  it("serializes check-then-start and refuses past the queue bound", async () => {
    let clock = 0;
    let running = 1;
    const admission = createDockerAdmission({
      maxRunning: 2,
      minFreeDiskPercent: 0,
      countRunning: async () => running,
      freeDiskPercent: async () => 100,
      waitMs: 0,
      queueLimit: 2,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    let finishFirst!: () => void;
    const first = admission.admit(
      () =>
        new Promise<string>((resolve) => {
          running++;
          finishFirst = () => resolve("first");
        })
    );
    const second = admission.admit(async () => "second");
    await expect(admission.admit(async () => "third")).rejects.toThrow("queue is full");
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf("function"));
    finishFirst();
    await expect(first).resolves.toBe("first");
    // The first start took the last slot, so the queued one sees a full host.
    await expect(second).rejects.toThrow("at capacity");
    await expect(admission.admit(async () => "later")).rejects.toThrow("at capacity");
    running = 1;
    await expect(admission.admit(async () => "later")).resolves.toBe("later");
  });
});
