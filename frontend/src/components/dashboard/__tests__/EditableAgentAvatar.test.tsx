import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EditableAgentAvatar } from "../EditableAgentAvatar";

describe("EditableAgentAvatar", () => {
  it("renders the agent initials and an upload control", () => {
    render(<EditableAgentAvatar name="Acme Watch" onSelect={() => {}} />);
    expect(screen.getByText("AW")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Change avatar for Acme Watch"),
    ).toBeInTheDocument();
  });

  it("renders the supplied image when a src is given", () => {
    render(
      <EditableAgentAvatar
        name="Acme Watch"
        src="data:image/png;base64,AAAA"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByRole("img", { name: "Acme Watch" })).toBeInTheDocument();
  });

  it("calls onSelect with the picked image", async () => {
    const onSelect = vi.fn();
    render(<EditableAgentAvatar name="Acme Watch" onSelect={onSelect} />);
    const file = new File(["data"], "pic.png", { type: "image/png" });
    await userEvent.upload(
      screen.getByLabelText("Change avatar for Acme Watch"),
      file,
    );
    expect(onSelect).toHaveBeenCalledWith(file);
  });
});
