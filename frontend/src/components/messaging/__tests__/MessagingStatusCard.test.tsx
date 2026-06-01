import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  disableMessaging,
  enableMessaging,
  type MessagingStatus,
} from "@/api/messaging";
import { MessagingStatusCard } from "../MessagingStatusCard";

vi.mock("@/api/messaging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/messaging")>();
  return { ...actual, enableMessaging: vi.fn(), disableMessaging: vi.fn() };
});

const mockEnable = vi.mocked(enableMessaging);
const mockDisable = vi.mocked(disableMessaging);

const off: MessagingStatus = {
  enabled: false,
  e164: null,
  a2p: { brand: null, campaign: null },
};
const on: MessagingStatus = {
  enabled: true,
  e164: "+14155550100",
  a2p: { brand: { status: "approved" }, campaign: { status: "approved" } },
};

describe("MessagingStatusCard", () => {
  beforeEach(() => {
    mockEnable.mockReset();
    mockDisable.mockReset();
  });

  it("enables messaging and refetches", async () => {
    mockEnable.mockResolvedValue({ e164: "+14155550100" });
    const onChanged = vi.fn();
    render(
      <MessagingStatusCard
        agentId="a1"
        status={off}
        loading={false}
        error={null}
        onChanged={onChanged}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Enable messaging" }),
    );
    expect(mockEnable).toHaveBeenCalledWith("a1", undefined);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("shows the number and disables when enabled", async () => {
    mockDisable.mockResolvedValue({ ok: true });
    const onChanged = vi.fn();
    render(
      <MessagingStatusCard
        agentId="a1"
        status={on}
        loading={false}
        error={null}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText("+14155550100")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Disable messaging" }),
    );
    expect(mockDisable).toHaveBeenCalledWith("a1");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
