import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Alert,
  Chip,
  ConsentFacts,
  Disclosure,
  Field,
  ProviderCard,
  SetupChecklist,
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

  describe("ConsentFacts", () => {
    it("renders every provided row and the children", () => {
      render(
        <ConsentFacts
          recipientName="TypeSafe"
          origin="https://api.typesafe.ai"
          recipientNote="This extension has no server of its own."
          sent={["model", "state"]}
          neverSent={["notes"]}
          why="check that your key works"
          when="only on Test connection"
        >
          <p>Stored encrypted on this device.</p>
        </ConsentFacts>,
      );
      expect(screen.getByText("Recipient")).toBeTruthy();
      expect(screen.getByText("Sent")).toBeTruthy();
      expect(screen.getByText("Never sent")).toBeTruthy();
      expect(screen.getByText("Why")).toBeTruthy();
      expect(screen.getByText("When")).toBeTruthy();
      expect(screen.getByText("model")).toBeTruthy();
      expect(screen.getByText("state")).toBeTruthy();
      expect(screen.getByText("notes")).toBeTruthy();
      expect(screen.getByText(/check that your key works/)).toBeTruthy();
      expect(screen.getByText(/only on Test connection/)).toBeTruthy();
      expect(screen.getByText("Stored encrypted on this device.")).toBeTruthy();
      expect(
        screen.getByText(/the only destination this consent covers/),
      ).toBeTruthy();
      expect(
        screen.getByText(/This extension has no server of its own/),
      ).toBeTruthy();
    });

    it("omits absent rows", () => {
      render(
        <ConsentFacts
          recipientName="your provider"
          origin="https://llm.example.com"
          sent={["model"]}
        />,
      );
      expect(screen.getByText("Recipient")).toBeTruthy();
      expect(screen.getByText("Sent")).toBeTruthy();
      expect(screen.queryByText("Never sent")).toBeNull();
      expect(screen.queryByText("Why")).toBeNull();
      expect(screen.queryByText("When")).toBeNull();
    });

    it("renders each fact exactly once (no sent/never-sent duplication)", () => {
      render(
        <ConsentFacts
          recipientName="TypeSafe"
          origin="https://api.typesafe.ai"
          sent={["bookmark title", "domain"]}
          neverSent={["notes", "page text"]}
          why="categorize"
          when="saving a bookmark"
        />,
      );
      // The merged-duplication regression: the never-sent facts appear only
      // in the Never sent row, never echoed in the Sent row's prose.
      expect(screen.getAllByText("notes")).toHaveLength(1);
      expect(screen.getAllByText("page text")).toHaveLength(1);
      expect(screen.getAllByText("bookmark title")).toHaveLength(1);
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

  describe("SetupChecklist", () => {
    it("renders steps with status and triggers onGo", () => {
      const onGo = vi.fn();
      render(
        <SetupChecklist
          steps={[
            {
              id: "step-1",
              title: "Step One",
              description: "First description",
              state: "done",
            },
            {
              id: "step-2",
              title: "Step Two",
              description: "Second description",
              state: "current",
              onGo,
            },
          ]}
        />,
      );

      expect(screen.getByText("Step One")).toBeTruthy();
      expect(screen.getByText("First description")).toBeTruthy();
      expect(screen.getByText("Step Two")).toBeTruthy();

      const btn = screen.getByRole("button", { name: /Step Two/ });
      fireEvent.click(btn);
      expect(onGo).toHaveBeenCalledOnce();
    });

    it("stretches list items and cards to full height and width for equal card height", () => {
      const onGo = vi.fn();
      const { container } = render(
        <SetupChecklist
          steps={[
            {
              id: "step-1",
              title: "Step One",
              description: "Short",
              state: "done",
            },
            {
              id: "step-2",
              title: "Step Two",
              description: "A much longer description spanning multiple lines",
              state: "current",
              onGo,
            },
          ]}
        />,
      );

      const items = container.querySelectorAll("li");
      expect(items.length).toBe(2);
      items.forEach((item) => {
        expect(item.className).toContain("flex");
        const card = item.firstElementChild as HTMLElement;
        expect(card).not.toBeNull();
        expect(card.className).toContain("w-full");
        expect(card.className).toContain("h-full");
        expect(card.className).toContain("flex");
        expect(card.className).toContain("flex-col");
      });
    });
  });
});
