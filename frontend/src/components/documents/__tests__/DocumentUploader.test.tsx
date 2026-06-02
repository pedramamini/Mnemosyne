import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentRecord } from "@/api/documents";
import { DocumentUploader } from "../DocumentUploader";
import { useAgentDocuments } from "../useAgentDocuments";

// The uploader is the unit under test; mock its data hook so we drive the list +
// capture the upload call without any network.
vi.mock("../useAgentDocuments", () => ({ useAgentDocuments: vi.fn() }));
const mockHook = vi.mocked(useAgentDocuments);

function makeDoc(
  over: Partial<DocumentRecord> & { id: string },
): DocumentRecord {
  return {
    agent_id: "agent-1",
    account_id: "acct-1",
    discovery_id: null,
    filename: "file.pdf",
    mime_type: "application/pdf",
    size_bytes: 1024,
    r2_key: "k",
    status: "pending",
    convert_method: null,
    markdown_chars: null,
    neuron_count: null,
    source_slug: null,
    error: null,
    created_at: 0,
    ...over,
  };
}

const upload = vi.fn().mockResolvedValue([]);

function setDocuments(documents: DocumentRecord[]) {
  mockHook.mockReturnValue({
    documents,
    loading: false,
    error: null,
    uploading: false,
    upload,
    remove: vi.fn(),
    refresh: vi.fn(),
  });
}

describe("DocumentUploader", () => {
  beforeEach(() => {
    upload.mockClear();
    upload.mockResolvedValue([]);
    setDocuments([]);
  });

  it("renders all four per-file status states", () => {
    setDocuments([
      makeDoc({ id: "1", filename: "a.pdf", status: "pending" }),
      makeDoc({ id: "2", filename: "b.docx", status: "converted" }),
      makeDoc({
        id: "3",
        filename: "c.csv",
        status: "seeded",
        neuron_count: 5,
        source_slug: "sources/c",
      }),
      makeDoc({
        id: "4",
        filename: "d.xml",
        status: "failed",
        error: "CONVERSION_FAILED: boom",
      }),
    ]);
    render(<DocumentUploader agentId="agent-1" variant="brain" />);

    expect(screen.getByText("Converting…")).toBeInTheDocument();
    expect(screen.getByText("Ready · seeds at build")).toBeInTheDocument();
    expect(screen.getByText("Seeded · 5 neurons")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    // The failed row surfaces the backend error message.
    expect(screen.getByText("CONVERSION_FAILED: boom")).toBeInTheDocument();
  });

  it("invokes upload when files are chosen via the picker", async () => {
    render(<DocumentUploader agentId="agent-1" variant="brain" />);
    const input = screen.getByLabelText(/choose files/i);
    const file = new File(["hello"], "notes.pdf", { type: "application/pdf" });
    await userEvent.upload(input, file);

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const [files] = upload.mock.calls[0];
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("notes.pdf");
  });

  it("invokes upload when files are dropped on the zone", async () => {
    render(<DocumentUploader agentId="agent-1" variant="discovery" />);
    const zone = screen.getByRole("group", { name: /attach documents/i });
    const file = new File(["hello"], "spec.docx");
    fireEvent.drop(zone, { dataTransfer: { files: [file], types: ["Files"] } });

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0][0][0].name).toBe("spec.docx");
  });

  it("rejects unsupported files client-side without calling upload", async () => {
    render(<DocumentUploader agentId="agent-1" variant="brain" />);
    const zone = screen.getByRole("group");
    const legacy = new File(["x"], "old.doc");
    fireEvent.drop(zone, {
      dataTransfer: { files: [legacy], types: ["Files"] },
    });

    expect(await screen.findByText(/couldn't be added/i)).toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
  });
});
