import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FileButton } from "../FileButton";

describe("FileButton", () => {
  it("renders the trigger content", () => {
    render(
      <FileButton label="Upload" onSelect={() => {}}>
        <span>Choose file</span>
      </FileButton>,
    );
    expect(screen.getByText("Choose file")).toBeInTheDocument();
  });

  it("exposes the input by its accessible label and accept type", () => {
    render(
      <FileButton label="Upload avatar" accept="image/*" onSelect={() => {}}>
        <span>Pick</span>
      </FileButton>,
    );
    const input = screen.getByLabelText("Upload avatar");
    expect(input).toHaveAttribute("type", "file");
    expect(input).toHaveAttribute("accept", "image/*");
  });

  it("calls onSelect with the chosen file", async () => {
    const onSelect = vi.fn();
    render(
      <FileButton label="Upload avatar" accept="image/*" onSelect={onSelect}>
        <span>Pick</span>
      </FileButton>,
    );
    const file = new File(["data"], "photo.png", { type: "image/png" });
    await userEvent.upload(screen.getByLabelText("Upload avatar"), file);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(file);
  });
});
