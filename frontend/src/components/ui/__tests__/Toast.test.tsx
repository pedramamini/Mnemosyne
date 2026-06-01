import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "../Button";
import { ToastProvider, useToast } from "../Toast";

function Harness({ duration }: { duration?: number }) {
  const { toast } = useToast();
  return (
    <Button
      onClick={() =>
        toast({ title: "Saved", description: "All good", duration })
      }
    >
      Notify
    </Button>
  );
}

describe("Toast", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enqueues a toast and auto-dismisses it after its duration", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Harness duration={1000} />
      </ToastProvider>,
    );

    // fireEvent (synchronous) avoids the userEvent/fake-timer interplay.
    fireEvent.click(screen.getByRole("button", { name: "Notify" }));
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByText("All good")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("can be dismissed manually via its close button", async () => {
    render(
      <ToastProvider>
        <Harness duration={0} />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Notify" }));
    expect(screen.getByText("Saved")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );
    expect(screen.queryByText("Saved")).toBeNull();
  });
});
