import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar, initialsOf } from "../Avatar";

describe("initialsOf", () => {
  it("derives up to two uppercase initials", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("grace")).toBe("GR");
    expect(initialsOf("Mary Ann Evans")).toBe("ME");
    expect(initialsOf("  ")).toBe("?");
  });
});

describe("Avatar", () => {
  it("renders initials when no image is provided", () => {
    render(<Avatar name="Ada Lovelace" />);
    const avatar = screen.getByRole("img", { name: "Ada Lovelace" });
    expect(avatar).toHaveTextContent("AL");
    expect(avatar.querySelector("img")).toBeNull();
  });

  it("renders an <img> when src is provided", () => {
    render(<Avatar name="Grace Hopper" src="https://example.com/g.png" />);
    const avatar = screen.getByRole("img", { name: "Grace Hopper" });
    const img = avatar.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "https://example.com/g.png");
  });
});
