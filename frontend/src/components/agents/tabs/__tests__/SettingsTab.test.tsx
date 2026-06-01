import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Agent, deleteAgent, updateAgent } from "@/api/agents";
import type { AgentDetailContext } from "@/pages/agents/AgentDetailPage";
import { SettingsTab } from "../SettingsTab";

// Mock the PATCH + DELETE; keep AGENT_TEMPLATES and the rest of the module real.
vi.mock("@/api/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/agents")>();
  return { ...actual, updateAgent: vi.fn(), deleteAgent: vi.fn() };
});

const mockUpdateAgent = vi.mocked(updateAgent);
const mockDeleteAgent = vi.mocked(deleteAgent);

// Spy on useNavigate so we can assert the post-delete redirect without mounting
// a second route. The rest of react-router-dom (MemoryRouter, Outlet) stays real.
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const agent: Agent = {
  id: "a1",
  name: "Acme Watch",
  description: "Tracks Acme Corp.",
  template: "vendor",
  status: "active",
  created_at: "2026-05-25T00:00:00.000Z",
};

function renderSettings() {
  const onAgentUpdated = vi.fn();
  const context: AgentDetailContext = { agent, onAgentUpdated };
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route index element={<SettingsTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return { onAgentUpdated };
}

describe("SettingsTab", () => {
  beforeEach(() => {
    mockUpdateAgent.mockReset();
    mockDeleteAgent.mockReset();
    mockNavigate.mockReset();
  });

  it("prefills the form from the loaded agent", () => {
    renderSettings();
    // "Name" is required, so its label text carries a "*" marker - query by the
    // control's computed accessible name (which excludes the aria-hidden marker).
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Acme Watch",
    );
    expect(screen.getByLabelText("Description")).toHaveValue(
      "Tracks Acme Corp.",
    );
    expect(screen.getByLabelText("Status")).toHaveValue("active");
  });

  it("saves only the changed fields and shows a saved state", async () => {
    mockUpdateAgent.mockResolvedValueOnce({
      ...agent,
      description: "Tracks Acme + Beta.",
      status: "paused",
    });
    const { onAgentUpdated } = renderSettings();

    const description = screen.getByLabelText("Description");
    await userEvent.clear(description);
    await userEvent.type(description, "Tracks Acme + Beta.");
    await userEvent.selectOptions(screen.getByLabelText("Status"), "paused");

    await userEvent.click(screen.getByRole("button", { name: /Save changes/ }));

    expect(mockUpdateAgent).toHaveBeenCalledWith("a1", {
      description: "Tracks Acme + Beta.",
      status: "paused",
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(onAgentUpdated).toHaveBeenCalled();
  });

  // The dialog renders both a "Delete agent" trigger (in the Danger zone panel)
  // and the "Delete agent" confirm button (in the modal footer), so we always
  // disambiguate by scoping queries to the dialog.
  async function openDangerZone() {
    await userEvent.click(
      screen.getByRole("button", { name: /^Delete agent$/ }),
    );
    return within(await screen.findByRole("dialog"));
  }

  it("gates the danger zone delete on typing the exact agent name", async () => {
    renderSettings();
    const dialog = await openDangerZone();

    const confirm = dialog.getByRole("button", { name: /^Delete agent$/ });
    expect(confirm).toBeDisabled();

    const input = dialog.getByRole("textbox", { name: /Type "Acme Watch"/ });
    await userEvent.type(input, "acme watch"); // wrong case
    expect(confirm).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, "Acme Watch");
    expect(confirm).toBeEnabled();
  });

  it("deletes the agent and navigates to /agents on success", async () => {
    mockDeleteAgent.mockResolvedValueOnce(undefined);
    renderSettings();
    const dialog = await openDangerZone();

    await userEvent.type(
      dialog.getByRole("textbox", { name: /Type "Acme Watch"/ }),
      "Acme Watch",
    );
    await userEvent.click(
      dialog.getByRole("button", { name: /^Delete agent$/ }),
    );

    expect(mockDeleteAgent).toHaveBeenCalledWith("a1");
    expect(mockNavigate).toHaveBeenCalledWith("/agents");
  });

  it("shows a danger banner and stays mounted when the delete fails", async () => {
    mockDeleteAgent.mockRejectedValueOnce(new Error("boom"));
    renderSettings();
    const dialog = await openDangerZone();

    await userEvent.type(
      dialog.getByRole("textbox", { name: /Type "Acme Watch"/ }),
      "Acme Watch",
    );
    await userEvent.click(
      dialog.getByRole("button", { name: /^Delete agent$/ }),
    );

    expect(await dialog.findByText("Couldn't delete")).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
