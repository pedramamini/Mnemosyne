import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Commit,
  type FileDiff,
  getCommitDiff,
  listBrainFiles,
  listCommits,
  restoreFile,
} from "@/api/brain";
import { ToastProvider } from "@/components/ui";
import { BrainHistoryPanel } from "../BrainHistoryPanel";
import { useBrainFiles } from "../useBrain";

// Mock the data layer; keep the real types + everything else.
vi.mock("@/api/brain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/brain")>();
  return {
    ...actual,
    listCommits: vi.fn(),
    getCommitDiff: vi.fn(),
    restoreFile: vi.fn(),
    listBrainFiles: vi.fn(),
  };
});

const mockListCommits = vi.mocked(listCommits);
const mockGetCommitDiff = vi.mocked(getCommitDiff);
const mockRestoreFile = vi.mocked(restoreFile);
const mockListBrainFiles = vi.mocked(listBrainFiles);

const NEWER = "aaaaaaa1111111111111111111111111111111aa";
const OLDER = "bbbbbbb2222222222222222222222222222222bb";

const commits: Commit[] = [
  {
    sha: NEWER,
    author: "Mnemosyne Agent",
    ts: Date.now() - 60 * 1000,
    subject: "memory: tweak welcome note",
    category: "memory",
  },
  {
    sha: OLDER,
    author: "Mnemosyne Agent",
    ts: Date.now() - 60 * 60 * 1000,
    subject: "init: seed brain",
    category: "init",
  },
];

const modifiedFile: FileDiff = {
  path: "notes/welcome.md",
  additions: 2,
  deletions: 1,
  patch: [
    "diff --git a/notes/welcome.md b/notes/welcome.md",
    "@@ -1,2 +1,3 @@",
    " hello",
    "-old line",
    "+new line one",
    "+new line two",
  ].join("\n"),
};

/** A sibling consumer of the files list, to prove restore invalidates it. */
function FilesProbe({ agentId }: { agentId: string }) {
  const { entries } = useBrainFiles(agentId);
  return <div data-testid="files-count">{entries.length}</div>;
}

function renderPanel() {
  render(
    <ToastProvider>
      <BrainHistoryPanel agentId="a1" />
      <FilesProbe agentId="a1" />
    </ToastProvider>,
  );
}

describe("BrainHistoryPanel", () => {
  beforeEach(() => {
    mockListCommits
      .mockReset()
      .mockResolvedValue({ entries: commits, nextCursor: null });
    mockGetCommitDiff.mockReset().mockResolvedValue([modifiedFile]);
    mockRestoreFile.mockReset().mockResolvedValue({
      path: "/brain/notes/welcome.md",
      commit: "newsha0",
    });
    mockListBrainFiles.mockReset().mockResolvedValue([]);
  });

  it("renders the commit list", async () => {
    renderPanel();

    expect(
      await screen.findByText("memory: tweak welcome note"),
    ).toBeInTheDocument();
    expect(screen.getByText("init: seed brain")).toBeInTheDocument();
    expect(mockListCommits).toHaveBeenCalledWith("a1", { path: undefined });
  });

  it("loads a commit's diff when it is selected", async () => {
    renderPanel();

    // Selecting the older commit fetches that commit's diff.
    await userEvent.click(await screen.findByText("init: seed brain"));

    await waitFor(() =>
      expect(mockGetCommitDiff).toHaveBeenCalledWith("a1", OLDER, undefined),
    );
    expect(await screen.findByText("notes/welcome.md")).toBeInTheDocument();
    // The diff body renders the changed lines.
    expect(screen.getByText("new line one")).toBeInTheDocument();
  });

  it("restores a file after confirming, then invalidates the files list", async () => {
    renderPanel();

    await userEvent.click(await screen.findByText("init: seed brain"));
    await screen.findByText("notes/welcome.md");

    // The probe loaded the files list once on mount.
    await waitFor(() => expect(mockListBrainFiles).toHaveBeenCalledTimes(1));

    // Open the confirm dialog, then confirm.
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm restore" }),
    );

    await waitFor(() =>
      expect(mockRestoreFile).toHaveBeenCalledWith(
        "a1",
        "notes/welcome.md",
        OLDER,
      ),
    );

    // Success invalidates the files list → the probe refetches.
    await waitFor(() => expect(mockListBrainFiles).toHaveBeenCalledTimes(2));
  });
});
