import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FormField } from "../FormField";
import { Input } from "../Input";

describe("Input + FormField", () => {
  it("associates the label with the control", () => {
    render(
      <FormField label="Email">
        <Input />
      </FormField>,
    );
    // getByLabelText only resolves if the label is correctly associated.
    const input = screen.getByLabelText("Email");
    expect(input).toBeInstanceOf(HTMLInputElement);
  });

  it("renders help text and wires aria-describedby", () => {
    render(
      <FormField label="Email" help="We never share it.">
        <Input />
      </FormField>,
    );
    const input = screen.getByLabelText("Email");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const help = screen.getByText("We never share it.");
    expect(help.id).toBe(describedBy);
  });

  it("marks the field invalid and surfaces the error via role=alert", () => {
    render(
      <FormField label="Password" error="Too short">
        <Input />
      </FormField>,
    );
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("Too short");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
  });
});
