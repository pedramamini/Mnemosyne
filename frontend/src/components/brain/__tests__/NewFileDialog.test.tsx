import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NewFileDialog } from "../NewFileDialog";

function renderDialog(defaultDir = "") {
  const onCreate = vi.fn();
  const onClose = vi.fn();
  render(
    <NewFileDialog
      open
      defaultDir={defaultDir}
      onCreate={onCreate}
      onClose={onClose}
    />,
  );
  return { onCreate, onClose };
}

describe("NewFileDialog", () => {
  it("rejects an empty path and shows a validation message", async () => {
    const { onCreate } = renderDialog("");

    await userEvent.click(screen.getByRole("button", { name: "Create file" }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a file path.")).toBeInTheDocument();
  });

  it("rejects a path containing a '..' segment", async () => {
    const { onCreate } = renderDialog("");

    await userEvent.type(screen.getByLabelText("Path"), "../outside/escape.md");
    await userEvent.click(screen.getByRole("button", { name: "Create file" }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(
      screen.getByText("Path must not contain “..” segments."),
    ).toBeInTheDocument();
  });

  it("accepts a valid relative path and calls onCreate", async () => {
    const { onCreate } = renderDialog("");

    await userEvent.type(screen.getByLabelText("Path"), "notes/new.md");
    await userEvent.type(
      screen.getByLabelText("Initial content"),
      "# New note",
    );
    await userEvent.click(screen.getByRole("button", { name: "Create file" }));

    expect(onCreate).toHaveBeenCalledWith("notes/new.md", "# New note");
  });

  it("prefills the path from the default directory", () => {
    renderDialog("notes");
    expect(screen.getByLabelText("Path")).toHaveValue("notes/");
  });
});
