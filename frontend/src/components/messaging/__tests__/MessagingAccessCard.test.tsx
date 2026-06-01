import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addWhitelistContact,
  type MessagingAccess,
  removeWhitelistContact,
  updateMessagingAccess,
} from "@/api/messaging";
import { MessagingAccessCard } from "../MessagingAccessCard";

vi.mock("@/api/messaging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/messaging")>();
  return {
    ...actual,
    updateMessagingAccess: vi.fn(),
    addWhitelistContact: vi.fn(),
    removeWhitelistContact: vi.fn(),
  };
});

const mockUpdate = vi.mocked(updateMessagingAccess);
const mockAdd = vi.mocked(addWhitelistContact);
const mockRemove = vi.mocked(removeWhitelistContact);

const access: MessagingAccess = {
  openToWorld: false,
  ownerNumber: null,
  whitelist: [
    { contactE164: "+14155550000", scope: "global", createdAt: "2026-05-25" },
  ],
};

describe("MessagingAccessCard", () => {
  beforeEach(() => {
    mockUpdate.mockReset().mockResolvedValue({
      openToWorld: true,
      ownerNumber: null,
    });
    mockAdd.mockReset().mockResolvedValue({ ok: true, contactE164: "+1" });
    mockRemove.mockReset().mockResolvedValue({ ok: true });
  });

  function renderCard() {
    render(
      <MessagingAccessCard
        agentId="a1"
        access={access}
        loading={false}
        error={null}
        onChanged={() => {}}
      />,
    );
  }

  it("toggles the open-to-world flag", async () => {
    renderCard();
    await userEvent.click(screen.getByLabelText("Open to the world"));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith("a1", { openToWorld: true }),
    );
  });

  it("adds a whitelist contact", async () => {
    renderCard();
    await userEvent.type(
      screen.getByLabelText("Add a contact number"),
      "+14155551212",
    );
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(mockAdd).toHaveBeenCalledWith("a1", "+14155551212");
  });

  it("removes a whitelisted contact", async () => {
    renderCard();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove +14155550000" }),
    );
    expect(mockRemove).toHaveBeenCalledWith("a1", "+14155550000");
  });
});
