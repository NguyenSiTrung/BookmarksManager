import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CostConfirmationDialog } from "../../src/ui/components/CostConfirmationDialog";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => cleanup());
afterAll(() => {
  vi.unstubAllGlobals();
});

const PROPS = {
  open: true,
  featureLabel: "Explain this decision",
  destinationOrigin: "https://api.openai.com",
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

describe("CostConfirmationDialog", () => {
  it("states the cost is unknown, names the feature and destination, and is modal-labelled", () => {
    render(<CostConfirmationDialog {...PROPS} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // The accessible name points at the title.
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(
      document.getElementById(labelledBy!)?.textContent,
    ).toMatch(/cost|confirm/i);
    expect(dialog.textContent).toMatch(/cost.*(unknown|cannot be estimated)/i);
    expect(dialog.textContent).toContain("Explain this decision");
    expect(dialog.textContent).toContain("https://api.openai.com");
    // Explicitly one-shot: no "always"/"remember" affordance exists.
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(dialog.textContent).not.toMatch(/always allow|remember this/i);
  });

  it("confirm fires once and cancel fires once — a one-shot decision", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <CostConfirmationDialog
        {...PROPS}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^send anyway$/i }),
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancel fires onCancel and never confirms", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <CostConfirmationDialog
        {...PROPS}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel|don.t send/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Escape cancels", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <CostConfirmationDialog
        {...PROPS}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    render(<CostConfirmationDialog {...PROPS} open={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
