import { describe, expect, it, vi } from "vitest";
import { coordinateJob } from "../../src/jobs/coordinator";

describe("coordinateJob", () => {
  it("shares the exact promise until the owner settles, then permits another drive", async () => {
    let releaseDrive!: () => void;
    const held = new Promise<void>((resolve) => { releaseDrive = resolve; });
    const drive = vi.fn(() => held);
    const first = coordinateJob("job-a", drive);
    const second = coordinateJob("job-a", drive);
    try {
      expect(first).toBe(second);
      await Promise.resolve();
      expect(drive).toHaveBeenCalledTimes(1);
    } finally {
      releaseDrive();
      await Promise.all([first, second]);
    }
    await coordinateJob("job-a", drive);
    expect(drive).toHaveBeenCalledTimes(2);
  });

  it("does not serialize different jobs", async () => {
    let release!: () => void;
    const first = coordinateJob("held", () => new Promise<void>((resolve) => { release = resolve; }));
    await coordinateJob("other", async () => {});
    release();
    await first;
  });

  it("releases ownership after a rejection or synchronous throw", async () => {
    for (const mode of ["rejection", "synchronous throw"]) {
      const failed = coordinateJob(`failure-${mode}`, () => {
        if (mode === "synchronous throw") throw new Error("failed");
        return Promise.reject(new Error("failed"));
      });
      await expect(failed, mode).rejects.toThrow("failed");
      await expect(coordinateJob(`failure-${mode}`, async () => {}), mode).resolves.toBeUndefined();
    }
  });

  it("preempts a wedged owner when options.preempt is true (B-15)", async () => {
    let releaseWedged!: () => void;
    const wedged = new Promise<void>((resolve) => {
      releaseWedged = resolve;
    });
    const firstDrive = vi.fn(() => wedged);
    const first = coordinateJob("job-preempt", firstDrive);

    let releasePreempt!: () => void;
    const secondHeld = new Promise<void>((resolve) => {
      releasePreempt = resolve;
    });
    const secondDrive = vi.fn(() => secondHeld);
    const second = coordinateJob("job-preempt", secondDrive, { preempt: true });

    expect(second).not.toBe(first);
    await Promise.resolve();
    expect(firstDrive).toHaveBeenCalledTimes(1);
    expect(secondDrive).toHaveBeenCalledTimes(1);

    // Subsequent non-preempt calls join the preempting owner, and settling
    // the wedged owner does not evict the active preempting owner.
    expect(coordinateJob("job-preempt", vi.fn())).toBe(second);
    releaseWedged();
    await first;
    expect(coordinateJob("job-preempt", vi.fn())).toBe(second);
    releasePreempt();
    await second;
  });
});
