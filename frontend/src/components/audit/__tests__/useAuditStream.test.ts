import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditAltitude, AuditEvent } from "@/api/audit";
import { fetchAuditPage } from "@/api/audit";
import { openAuditStream } from "@/api/auditStream";
import { useAuditStream } from "../useAuditStream";

vi.mock("@/api/audit", () => ({ fetchAuditPage: vi.fn() }));
vi.mock("@/api/auditStream", () => ({ openAuditStream: vi.fn() }));

const mockFetch = vi.mocked(fetchAuditPage);
const mockOpen = vi.mocked(openAuditStream);

function makeEvent(seq: number, over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    seq,
    ts: new Date().toISOString(),
    type: "memory.wrote",
    level: "milestone",
    sessionId: "s1",
    summary: `event ${seq}`,
    ...over,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockOpen.mockReset();
});

describe("useAuditStream", () => {
  it("loads the initial page, appends a higher-seq event, and ignores duplicates", async () => {
    mockFetch.mockResolvedValue({
      events: [makeEvent(1), makeEvent(2)],
      nextSeq: 2,
    });
    let emit: (event: AuditEvent) => void = () => {};
    const close = vi.fn();
    mockOpen.mockImplementation((_id, _opts, onEvent) => {
      emit = onEvent;
      return { close };
    });

    const { result } = renderHook(() => useAuditStream("a1", {}, "milestone"));

    // (1) initial page loaded.
    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(result.current.events.map((e) => e.seq)).toEqual([1, 2]);
    // (2) the live stream opened from the page's last seq.
    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen.mock.calls[0][1]).toMatchObject({ sinceSeq: 2 });

    // (3) a higher-seq streamed event is appended in order.
    act(() => emit(makeEvent(3)));
    expect(result.current.events.map((e) => e.seq)).toEqual([1, 2, 3]);

    // (4) a duplicate seq does not produce a second row.
    act(() => emit(makeEvent(3, { summary: "dupe" })));
    expect(result.current.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("re-subscribes when the altitude changes, closing the old handle", async () => {
    mockFetch.mockResolvedValue({ events: [makeEvent(1)], nextSeq: 1 });
    const close1 = vi.fn();
    const close2 = vi.fn();
    mockOpen
      .mockImplementationOnce(() => ({ close: close1 }))
      .mockImplementationOnce(() => ({ close: close2 }));

    const { rerender } = renderHook(
      ({ level }: { level: AuditAltitude }) => useAuditStream("a1", {}, level),
      { initialProps: { level: "milestone" as AuditAltitude } },
    );

    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));

    rerender({ level: "all" });

    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(2));
    // The old subscription was torn down before the new one opened.
    expect(close1).toHaveBeenCalled();
    // The new subscription carries the new altitude.
    expect(mockOpen.mock.calls[1][1].filters).toMatchObject({ level: "all" });
  });
});
