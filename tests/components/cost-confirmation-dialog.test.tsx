import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CostConfirmationDialog } from "../../src/ui/components/CostConfirmationDialog";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => cleanup());
afterAll(() => vi.unstubAllGlobals());

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
    // react-dialog 1.1.23 (the shared primitive every dialog here uses)
    // emits no aria-modal — modal semantics are its focus trap + overlay.
    // What it guarantees: the name and description are wired to the title
    // and description ids.
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(
      document.getElementById(labelledBy!)?.textContent,
    ).toMatch(/send without a cost estimate/i);
    const describedBy = dialog.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(
      document.getElementById(describedBy!)?.textContent,
    ).toMatch(/has no pricing configured/i);
    expect(dialog.textContent).toMatch(/can.t be estimated/i);
    expect(dialog.textContent).toContain("Explain this decision");
    expect(dialog.textContent).toContain("https://api.openai.com");
    expect(dialog.textContent).toMatch(/asked again for each request/i);
    // Explicitly one-shot: no "always"/"remember" affordance exists.
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(dialog.textContent).not.toMatch(/always allow|remember this/i);
  });

  it("focuses “Don’t send” on open so Enter cannot confirm", () => {
    render(<CostConfirmationDialog {...PROPS} />);
    expect(document.activeElement?.textContent).toBe("Don’t send");
  });

  it("confirm fires once and never cancels", () => {
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
    fireEvent.click(screen.getByRole("button", { name: /don.t send/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Escape cancels (the safe action)", () => {
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

  it("a pointerdown on the overlay cancels (the safe action)", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <CostConfirmationDialog
        {...PROPS}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).not.toBeNull();
    // Radix attaches its document pointerdown listener in a setTimeout(0)
    // after mount, and defers outside dismissal until the click completes —
    // let the task run, then finish the synthetic interaction.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.pointerDown(overlay!);
    fireEvent.pointerUp(overlay!);
    fireEvent.click(overlay!);
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    render(<CostConfirmationDialog {...PROPS} open={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
