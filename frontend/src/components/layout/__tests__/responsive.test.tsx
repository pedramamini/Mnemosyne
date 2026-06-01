import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "@/components/ui";
import { restoreMatchMedia, stubMatchMedia } from "@/test/matchMedia";
import { ResponsiveMasterDetail } from "../ResponsiveMasterDetail";
import { useBreakpoint, useIsMobile } from "../useBreakpoint";

afterEach(() => {
  restoreMatchMedia();
});

describe("useIsMobile / useBreakpoint", () => {
  it("reports mobile below the md breakpoint", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it("reports desktop at/above the md breakpoint", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it("useBreakpoint(md) is true on desktop and false on mobile", () => {
    stubMatchMedia(false);
    expect(renderHook(() => useBreakpoint("md")).result.current).toBe(true);

    stubMatchMedia(true);
    expect(renderHook(() => useBreakpoint("md")).result.current).toBe(false);
  });

  it("defaults to desktop when matchMedia is unavailable (SSR/jsdom)", () => {
    restoreMatchMedia();
    expect(renderHook(() => useIsMobile()).result.current).toBe(false);
  });
});

/** A controlled harness: the master holds a "select" trigger that pushes detail. */
function Harness() {
  const [show, setShow] = useState(false);
  return (
    <ResponsiveMasterDetail
      showDetail={show}
      onBack={() => setShow(false)}
      master={<Button onClick={() => setShow(true)}>Select item</Button>}
      detail={<div>Detail content</div>}
    />
  );
}

describe("ResponsiveMasterDetail", () => {
  it("renders both master and detail on desktop", () => {
    stubMatchMedia(false);
    render(
      <ResponsiveMasterDetail
        showDetail={false}
        onBack={() => {}}
        master={<div>Master content</div>}
        detail={<div>Detail content</div>}
      />,
    );
    expect(screen.getByText("Master content")).toBeInTheDocument();
    expect(screen.getByText("Detail content")).toBeInTheDocument();
  });

  it("on mobile shows the master, then pushes the detail and backs out", async () => {
    stubMatchMedia(true);
    render(<Harness />);

    // Master first; detail not mounted.
    expect(
      screen.getByRole("button", { name: "Select item" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Detail content")).toBeNull();

    // Selecting an item pushes the detail with a working back control.
    await userEvent.click(screen.getByRole("button", { name: "Select item" }));
    expect(screen.getByText("Detail content")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Select item" })).toBeNull();

    const back = screen.getByRole("button", { name: "Back" });
    await userEvent.click(back);

    // Back returns to the master.
    expect(
      screen.getByRole("button", { name: "Select item" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Detail content")).toBeNull();
  });
});
