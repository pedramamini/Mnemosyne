import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FileEditor } from "../FileEditor";

describe("FileEditor", () => {
  it("shows the empty state when no file is selected", () => {
    render(
      <FileEditor path={null} content="" onSave={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(screen.getByText("Select a file to view")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("renders the file content and the path header", () => {
    render(
      <FileEditor
        path="notes/a.md"
        content="hello"
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "notes/a.md" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("hello");
  });

  it("disables Save until the content changes, then saves the edits", async () => {
    const onSave = vi.fn();
    render(
      <FileEditor
        path="notes/a.md"
        content="hello"
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    const textarea = screen.getByRole("textbox");
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "edited body");

    expect(save).toBeEnabled();
    await userEvent.click(save);

    expect(onSave).toHaveBeenCalledWith("edited body");
  });
});
