import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Input } from "../Input";
import { SettingRow } from "../SettingRow";

describe("SettingRow", () => {
  it("renders the label, description, and right-column control", () => {
    render(
      <SettingRow label="Your name" description="Shown to your agents.">
        <span>control</span>
      </SettingRow>,
    );
    expect(screen.getByText("Your name")).toBeInTheDocument();
    expect(screen.getByText("Shown to your agents.")).toBeInTheDocument();
    expect(screen.getByText("control")).toBeInTheDocument();
  });

  it("associates the label with the control via htmlFor", () => {
    render(
      <SettingRow label="Your name" htmlFor="name-input">
        <Input id="name-input" defaultValue="Pedram" />
      </SettingRow>,
    );
    expect(screen.getByLabelText("Your name")).toHaveValue("Pedram");
  });
});
