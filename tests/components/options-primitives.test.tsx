import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Alert,
  Chip,
  Disclosure,
  Field,
  ProviderCard,
  StatusBadge,
  Switch,
} from "../../src/entrypoints/options/components";

/**
 * Contract tests for the options primitives: roles, labels, and interactive
 * behavior — the things every redesigned panel leans on. Presentational
 * details (colors, spacing) are deliberately unasserted.
 */
describe("options primitives", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(cleanup);

  describe("Switch", () => {
    it("renders a switch role reflecting checked state", () => {
      render(<Switch checked={false} onCheckedChange={() => {}} aria-label="Auto-apply tags" />);
      const sw = screen.getByRole("switch", { name: "Auto-apply tags" });
      expect(sw.getAttribute("aria-checked")).toBe("false");
    });

    it("fires onCheckedChange on click", () => {
      const onChange = vi.fn();
      render(<Switch checked={false} onCheckedChange={onChange} aria-label="Auto-apply tags" />);
      fireEvent.click(screen.getByRole("switch"));
      expect(onChange).toHaveBeenCalledWith(true);
    });

    it("honors disabled", () => {
      const onChange = vi.fn();
      render(<Switch checked={false} onCheckedChange={onChange} disabled aria-label="Auto-apply tags" />);
      const sw = screen.getByRole("switch");
      expect(sw).toHaveProperty("disabled", true);
      fireEvent.click(sw);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe("Alert", () => {
    it("uses role=status for advisory tones", () => {
      render(<Alert tone="success">Saved.</Alert>);
      expect(screen.getByRole("status").textContent).toContain("Saved.");
    });

    it("uses role=alert for errors", () => {
      render(<Alert tone="error">Something went wrong.</Alert>);
      expect(screen.getByRole("alert").textContent).toContain("Something went wrong.");
    });

    it("uses role=status for warnings", () => {
      render(<Alert tone="warning">Cap reached.</Alert>);
      expect(screen.getByRole("status").textContent).toContain("Cap reached.");
    });
  });

  describe("Field", () => {
    it("links the label to the control and renders the hint", () => {
      render(
        <Field label="API key" htmlFor="api-key" hint="Stored encrypted on this device.">
          <input id="api-key" />
        </Field>,
      );
      const input = screen.getByLabelText("API key");
      expect(input.id).toBe("api-key");
      expect(screen.getByText("Stored encrypted on this device.")).toBeTruthy();
    });

    it("replaces the hint with an alert when error is set", () => {
      render(
        <Field label="Base URL" htmlFor="base-url" hint="HTTPS required." error="Invalid URL.">
          <input id="base-url" />
        </Field>,
      );
      expect(screen.getByRole("alert").textContent).toBe("Invalid URL.");
      expect(screen.queryByText("HTTPS required.")).toBeNull();
    });
  });

  describe("StatusBadge", () => {
    it("renders the on/off label", () => {
      const { rerender } = render(<StatusBadge on={false} />);
      expect(screen.getByText("Not set up")).toBeTruthy();
      rerender(<StatusBadge on />);
      expect(screen.getByText("Active")).toBeTruthy();
    });
  });

  describe("Chip", () => {
    it("renders children and calls onRemove from a named button", () => {
      const onRemove = vi.fn();
      render(<Chip onRemove={onRemove} removeLabel="Remove example.com">example.com</Chip>);
      fireEvent.click(screen.getByRole("button", { name: "Remove example.com" }));
      expect(onRemove).toHaveBeenCalledOnce();
    });

    it("omits the remove button without onRemove", () => {
      render(<Chip>api.typesafe.ai</Chip>);
      expect(screen.queryByRole("button")).toBeNull();
    });
  });

  describe("ProviderCard", () => {
    it("renders a radio with title, description and aside status", () => {
      render(
        <ProviderCard
          name="provider"
          value="typesafe"
          checked={false}
          onChange={() => {}}
          title="TypeSafe"
          description="Curated Jev endpoint"
          aside={<StatusBadge on />}
        />,
      );
      const radio = screen.getByRole("radio");
      expect(radio.getAttribute("value")).toBe("typesafe");
      expect(screen.getByText("TypeSafe")).toBeTruthy();
      expect(screen.getByText("Curated Jev endpoint")).toBeTruthy();
      expect(screen.getByText("Active")).toBeTruthy();
    });

    it("fires onChange when clicked", () => {
      const onChange = vi.fn();
      render(
        <ProviderCard
          name="provider"
          value="openrouter"
          checked={false}
          onChange={onChange}
          title="OpenRouter"
        />,
      );
      fireEvent.click(screen.getByText("OpenRouter"));
      expect(onChange).toHaveBeenCalledOnce();
    });
  });

  describe("Disclosure", () => {
    it("renders open when open=true and hides content when closed", () => {
      const { rerender } = render(
        <Disclosure title="What this sends" open>
          <p>Disclosure body</p>
        </Disclosure>,
      );
      let details = screen.getByText("What this sends").closest("details");
      expect(details?.open).toBe(true);
      rerender(
        <Disclosure title="What this sends" open={false}>
          <p>Disclosure body</p>
        </Disclosure>,
      );
      details = screen.getByText("What this sends").closest("details");
      expect(details?.open).toBe(false);
    });

    it("reports toggles through onOpenChange", () => {
      const onOpenChange = vi.fn();
      render(
        <Disclosure title="What this sends" open={false} onOpenChange={onOpenChange}>
          <p>Disclosure body</p>
        </Disclosure>,
      );
      // jsdom does not dispatch toggle on summary click — fire it directly.
      const details = screen
        .getByText("What this sends")
        .closest("details") as HTMLDetailsElement;
      details.open = true;
      fireEvent(details, new Event("toggle"));
      expect(onOpenChange).toHaveBeenCalledWith(true);
    });
  });
});
