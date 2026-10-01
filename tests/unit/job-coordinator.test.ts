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

  it.each(["rejection", "synchronous throw"])("releases ownership after %s", async (mode) => {
    const failed = coordinateJob(`failure-${mode}`, () => {
      if (mode === "synchronous throw") throw new Error("failed");
      return Promise.reject(new Error("failed"));
    });
    await expect(failed).rejects.toThrow("failed");
    await expect(coordinateJob(`failure-${mode}`, async () => {})).resolves.toBeUndefined();
  });
});
