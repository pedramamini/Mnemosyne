import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestMagicLink } from "@/api/auth";
import { LoginPage } from "../LoginPage";

vi.mock("@/api/auth", () => ({
  requestMagicLink: vi.fn(),
}));

const mockRequest = vi.mocked(requestMagicLink);

describe("LoginPage", () => {
  beforeEach(() => {
    mockRequest.mockReset();
    // Production-shaped response: no devMagicLink (the staging-only field is absent).
    mockRequest.mockResolvedValue({});
  });

  it("submits a valid email, calls the API, and shows the check-your-email confirmation", async () => {
    render(<LoginPage />);

    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.com");
    await userEvent.click(
      screen.getByRole("button", { name: /send magic link/i }),
    );

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith("ada@example.com");

    // Neutral confirmation state with the email echoed back + a reset link.
    expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /use a different email/i }),
    ).toBeInTheDocument();
  });

  it("shows a validation error and does NOT call the API for an empty email", async () => {
    render(<LoginPage />);

    await userEvent.click(
      screen.getByRole("button", { name: /send magic link/i }),
    );

    expect(mockRequest).not.toHaveBeenCalled();
    expect(screen.getByText(/enter your email address/i)).toBeInTheDocument();
  });

  it("shows a validation error and does NOT call the API for a malformed email", async () => {
    render(<LoginPage />);

    await userEvent.type(screen.getByLabelText(/email/i), "not-an-email");
    await userEvent.click(
      screen.getByRole("button", { name: /send magic link/i }),
    );

    expect(mockRequest).not.toHaveBeenCalled();
    expect(
      screen.getByText(/enter a valid email address/i),
    ).toBeInTheDocument();
  });
});
