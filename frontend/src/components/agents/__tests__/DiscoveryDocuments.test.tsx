import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryState } from "@/api/discovery";
import type { DocumentRecord } from "@/api/documents";
import { listDocuments, uploadDocuments } from "@/api/documents";
import { DiscoveryChat } from "../DiscoveryChat";

// Keep the Discovery transport inert (DiscoveryChat imports it); we never send a
// turn here, only attach a document.
vi.mock("@/api/discovery", () => ({
  sendDiscoveryMessage: vi.fn(),
  finalizeDiscovery: vi.fn(),
}));

// Keep the documents constants/gate real (the uploader uses them); stub only the
// network functions so the REAL useAgentDocuments hook drives the indicator.
vi.mock("@/api/documents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/documents")>();
  return {
    ...actual,
    uploadDocuments: vi.fn(),
    listDocuments: vi.fn(),
    deleteDocument: vi.fn(),
  };
});

const mockUpload = vi.mocked(uploadDocuments);
const mockList = vi.mocked(listDocuments);

const gateClosed: DiscoveryState = {
  messages: [{ role: "assistant", content: "What should this agent track?" }],
  rubric: {
    subject: false,
    entityType: false,
    sources: false,
    cadence: false,
    outputFormat: false,
  },
  confidence: 0,
  ready: false,
};

function makeDoc(): DocumentRecord {
  return {
    id: "doc-1",
    agent_id: "agent-1",
    account_id: "acct-1",
    discovery_id: "agent-1",
    filename: "brief.pdf",
    mime_type: "application/pdf",
    size_bytes: 2048,
    r2_key: "k",
    status: "converted",
    convert_method: "tomarkdown",
    markdown_chars: 800,
    neuron_count: null,
    source_slug: null,
    error: null,
    created_at: 0,
  };
}

describe("Discovery document attachment indicator", () => {
  beforeEach(() => {
    mockUpload.mockReset();
    mockList.mockReset();
  });

  it("surfaces the attached-count indicator near the gate after an upload", async () => {
    // The list is empty until an upload lands, then reflects the new doc.
    let uploaded = false;
    mockList.mockImplementation(async () => (uploaded ? [makeDoc()] : []));
    mockUpload.mockImplementation(async () => {
      uploaded = true;
      return [
        {
          docId: "doc-1",
          status: "converted",
          sourceSlug: null,
          neuronCount: 0,
          error: null,
        },
      ];
    });

    render(
      <DiscoveryChat
        discoveryId="agent-1"
        initialState={gateClosed}
        onCreated={vi.fn()}
      />,
    );

    // No documents yet → no indicator.
    expect(screen.queryByText(/\d+ documents? attached/i)).toBeNull();

    // Attach a supported file through the picker.
    const input = screen.getByLabelText(/choose files/i);
    await userEvent.upload(
      input,
      new File(["x"], "brief.pdf", { type: "application/pdf" }),
    );

    // The indicator appears once the refreshed list reports the attachment.
    expect(await screen.findByText(/1 document attached/i)).toBeInTheDocument();
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });
});
