import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BrainEntry,
  type BrainFileContent,
  brainArchiveUrl,
  deleteBrainFile,
  listBrainFiles,
  readBrainFile,
  writeBrainFile,
} from "@/api/brain";
import { ToastProvider } from "@/components/ui";
import { restoreMatchMedia, stubMatchMedia } from "@/test/matchMedia";
import { BrainExplorerTab } from "../BrainExplorerTab";

// Mock the data calls; keep brainArchiveUrl + the types real so the download
// link asserts against the real URL builder.
vi.mock("@/api/brain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/brain")>();
  return {
    ...actual,
    listBrainFiles: vi.fn(),
    readBrainFile: vi.fn(),
    writeBrainFile: vi.fn(),
    deleteBrainFile: vi.fn(),
  };
});

const mockList = vi.mocked(listBrainFiles);
const mockRead = vi.mocked(readBrainFile);
const mockWrite = vi.mocked(writeBrainFile);
const mockDelete = vi.mocked(deleteBrainFile);

const tree: BrainEntry[] = [
  { path: "/brain/notes", type: "dir", size: 0, modified: 0 },
  { path: "/brain/notes/welcome.md", type: "file", size: 20, modified: 0 },
];

const welcome: BrainFileContent = {
  path: "/brain/notes/welcome.md",
  content: "Hello brain",
  encoding: "utf8",
  size: 20,
};

function renderTab() {
  render(
    <ToastProvider>
      <BrainExplorerTab agentId="a1" />
    </ToastProvider>,
  );
}

/** Expand the `notes` directory and open `welcome.md` in the editor. */
async function openWelcome() {
  await userEvent.click(await screen.findByRole("button", { name: "notes" }));
  await userEvent.click(screen.getByRole("button", { name: "welcome.md" }));
  await screen.findByDisplayValue("Hello brain");
}

describe("BrainExplorerTab", () => {
  beforeEach(() => {
    mockList.mockReset().mockResolvedValue(tree);
    mockRead.mockReset().mockResolvedValue(welcome);
    mockWrite
      .mockReset()
      .mockResolvedValue({ path: "/brain/notes/welcome.md", commit: "sha" });
    mockDelete.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    restoreMatchMedia();
  });

  it("renders the brain tree from listBrainFiles", async () => {
    renderTab();
    expect(
      await screen.findByRole("button", { name: "notes" }),
    ).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledWith("a1");
  });

  it("loads a file's content into the editor when selected", async () => {
    renderTab();
    await openWelcome();

    expect(mockRead).toHaveBeenCalledWith("a1", "notes/welcome.md");
    expect(screen.getByDisplayValue("Hello brain")).toBeInTheDocument();
  });

  it("saves edits via writeBrainFile", async () => {
    renderTab();
    await openWelcome();

    const textarea = screen.getByLabelText("Contents of notes/welcome.md");
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "Updated brain");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(mockWrite).toHaveBeenCalledWith(
      "a1",
      "notes/welcome.md",
      "Updated brain",
    );
  });

  it("creates a file with the dialog via writeBrainFile", async () => {
    renderTab();
    await screen.findByRole("button", { name: "notes" });

    await userEvent.click(screen.getByRole("button", { name: "New file" }));
    await userEvent.type(screen.getByLabelText("Path"), "notes/new.md");
    await userEvent.click(screen.getByRole("button", { name: "Create file" }));

    expect(mockWrite).toHaveBeenCalledWith("a1", "notes/new.md", "");
  });

  it("deletes a file via deleteBrainFile after confirming", async () => {
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "notes" }));

    await userEvent.click(
      screen.getByRole("button", { name: "Delete notes/welcome.md" }),
    );
    // Confirm in the modal.
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith("a1", "notes/welcome.md"),
    );
  });

  it("on a mobile viewport renders the tree first, not the editor", async () => {
    stubMatchMedia(true);
    renderTab();

    // The master (tree) is shown; the detail (editor) is not yet mounted, so its
    // empty-state prompt is absent - proving the master/detail mobile branch.
    expect(
      await screen.findByRole("button", { name: "notes" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Select a file to view")).toBeNull();
  });

  it("links the download button to the archive URL", async () => {
    renderTab();
    await screen.findByRole("button", { name: "notes" });

    const link = screen.getByRole("link", { name: /Download brain/ });
    expect(link).toHaveAttribute("href", brainArchiveUrl("a1"));
  });
});
