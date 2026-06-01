import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportSearchBox } from "../ReportSearchBox";

describe("ReportSearchBox", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces typing and calls onQueryChange once with the final value", () => {
    const onQueryChange = vi.fn();
    render(<ReportSearchBox value="" onQueryChange={onQueryChange} />);

    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "ac" } });
    fireEvent.change(input, { target: { value: "acme" } });

    // Nothing fires until the debounce window elapses.
    expect(onQueryChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(onQueryChange).toHaveBeenCalledTimes(1);
    expect(onQueryChange).toHaveBeenCalledWith("acme");
  });

  it("clears immediately via the clear button", () => {
    const onQueryChange = vi.fn();
    render(<ReportSearchBox value="" onQueryChange={onQueryChange} />);

    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "acme" } });

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    // The pending debounce is cancelled; clear reports "" right away.
    expect(onQueryChange).toHaveBeenCalledTimes(1);
    expect(onQueryChange).toHaveBeenCalledWith("");
    expect((input as HTMLInputElement).value).toBe("");
  });
});
