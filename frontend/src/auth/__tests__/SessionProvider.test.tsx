import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMe, logout } from "@/api/auth";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui";
import { SessionProvider } from "../SessionProvider";
import { useSession } from "../useSession";

// Mock only the auth API; use the REAL client (ApiError/isUnauthorized/
// onUnauthorized) so the 401 path is exercised end to end.
vi.mock("@/api/auth", () => ({
  getMe: vi.fn(),
  logout: vi.fn(),
}));

const mockGetMe = vi.mocked(getMe);
const mockLogout = vi.mocked(logout);

/** A consumer that surfaces the session state + a sign-out trigger. */
function Probe() {
  const { status, account, signOut } = useSession();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="email">{account?.email ?? ""}</span>
      <Button onClick={() => void signOut()}>Sign out</Button>
    </div>
  );
}

function renderProvider() {
  return render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
}

describe("SessionProvider", () => {
  beforeEach(() => {
    mockGetMe.mockReset();
    mockLogout.mockReset();
  });

  it("becomes authenticated when /api/me resolves", async () => {
    mockGetMe.mockResolvedValue({
      id: "a1",
      email: "ada@example.com",
      profile: { timezone: null, name: null, notes: null },
    });
    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated"),
    );
    expect(screen.getByTestId("email")).toHaveTextContent("ada@example.com");
  });

  it("becomes anonymous when /api/me rejects with a 401", async () => {
    mockGetMe.mockRejectedValue(new ApiError(401, "unauthorized", null));
    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("anonymous"),
    );
    expect(screen.getByTestId("email")).toHaveTextContent("");
  });

  it("signOut calls logout and flips to anonymous", async () => {
    mockGetMe.mockResolvedValue({
      id: "a1",
      email: "ada@example.com",
      profile: { timezone: null, name: null, notes: null },
    });
    mockLogout.mockResolvedValue(undefined);
    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated"),
    );

    await userEvent.click(screen.getByRole("button", { name: /sign out/i }));

    expect(mockLogout).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("anonymous"),
    );
  });
});
