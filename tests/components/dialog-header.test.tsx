import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../src/ui/components/dialog";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => cleanup());
afterAll(() => vi.unstubAllGlobals());

describe("DialogHeader", () => {
  it("left-aligns at every width — no text-center, no sm:text-left", () => {
    render(
      <Dialog open onOpenChange={() => undefined}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import bookmarks</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    );
    const header = document.querySelector('[data-slot="dialog-header"]');
    expect(header).not.toBeNull();
    expect(header?.className).toContain("text-left");
    expect(header?.className).not.toContain("text-center");
    expect(header?.className).not.toContain("sm:text-left");
  });
});
