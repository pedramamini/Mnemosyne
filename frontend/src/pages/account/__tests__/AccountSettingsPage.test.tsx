import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Account, updateProfile } from "@/api/auth";
import { SessionContext, type SessionContextValue } from "@/auth/useSession";
import { AccountSettingsForm } from "../AccountSettingsPage";

// Mock the PUT; keep the rest of the auth module real.
vi.mock("@/api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/auth")>();
  return { ...actual, updateProfile: vi.fn() };
});

const mockUpdateProfile = vi.mocked(updateProfile);

const account: Account = {
  id: "acc1",
  email: "pedram@example.com",
  profile: {
    timezone: "America/Chicago",
    name: "Pedram",
    notes: "Direct, no fluff.",
  },
};

function renderForm(overrides: Partial<SessionContextValue> = {}) {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const value: SessionContextValue = {
    status: "authenticated",
    account,
    refresh,
    signOut: vi.fn(),
    ...overrides,
  };
  render(
    <SessionContext.Provider value={value}>
      <AccountSettingsForm />
    </SessionContext.Provider>,
  );
  return { refresh };
}

describe("AccountSettingsForm", () => {
  beforeEach(() => {
    mockUpdateProfile.mockReset();
  });

  it("prefills the form from the session's owner profile", () => {
    renderForm();
    expect(screen.getByLabelText("Your name")).toHaveValue("Pedram");
    expect(screen.getByLabelText("Timezone")).toHaveValue("America/Chicago");
    expect(screen.getByLabelText("About you")).toHaveValue("Direct, no fluff.");
  });

  it("saves the profile, re-probes the session, and shows a saved state", async () => {
    mockUpdateProfile.mockResolvedValueOnce({
      timezone: "America/Chicago",
      name: "Pedram A",
      notes: "Direct, no fluff.",
    });
    const { refresh } = renderForm();

    const name = screen.getByLabelText("Your name");
    await userEvent.clear(name);
    await userEvent.type(name, "Pedram A");
    await userEvent.click(screen.getByRole("button", { name: /Save changes/ }));

    expect(mockUpdateProfile).toHaveBeenCalledWith({
      name: "Pedram A",
      timezone: "America/Chicago",
      notes: "Direct, no fluff.",
    });
    expect(refresh).toHaveBeenCalled();
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("sends null for a cleared field", async () => {
    mockUpdateProfile.mockResolvedValueOnce({
      timezone: "America/Chicago",
      name: null,
      notes: "Direct, no fluff.",
    });
    renderForm();

    await userEvent.clear(screen.getByLabelText("Your name"));
    await userEvent.click(screen.getByRole("button", { name: /Save changes/ }));

    expect(mockUpdateProfile).toHaveBeenCalledWith({
      name: null,
      timezone: "America/Chicago",
      notes: "Direct, no fluff.",
    });
  });
});
