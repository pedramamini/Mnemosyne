import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/auth/useSession";
import { RequireAuth } from "../RequireAuth";

vi.mock("@/auth/useSession", () => ({ useSession: vi.fn() }));

const mockUseSession = vi.mocked(useSession);

function setStatus(status: "loading" | "authenticated" | "anonymous") {
  mockUseSession.mockReturnValue({
    status,
    account:
      status === "authenticated"
        ? {
            id: "a1",
            email: "ada@example.com",
            profile: { timezone: null, name: null, notes: null },
          }
        : null,
    refresh: vi.fn(),
    signOut: vi.fn(),
  });
}

/** Render RequireAuth gating a protected route, with a /login decoy. */
function renderGated() {
  return render(
    <MemoryRouter initialEntries={["/secret"]}>
      <Routes>
        <Route
          path="/secret"
          element={
            <RequireAuth>
              <div>protected content</div>
            </RequireAuth>
          }
        />
        <Route path="/login" element={<div>login screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RequireAuth", () => {
  beforeEach(() => {
    mockUseSession.mockReset();
  });

  it("renders a spinner while the session is loading", () => {
    setStatus("loading");
    renderGated();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText("protected content")).toBeNull();
  });

  it("redirects to /login when anonymous", () => {
    setStatus("anonymous");
    renderGated();
    expect(screen.getByText("login screen")).toBeInTheDocument();
    expect(screen.queryByText("protected content")).toBeNull();
  });

  it("renders children when authenticated", () => {
    setStatus("authenticated");
    renderGated();
    expect(screen.getByText("protected content")).toBeInTheDocument();
  });
});
