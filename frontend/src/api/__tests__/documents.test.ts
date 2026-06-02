import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchInit,
  fetchUrl,
  installFetchMock,
  jsonResponse,
} from "../../test/apiMock";
import type { DocumentRecord } from "../documents";
import {
  checkFile,
  deleteDocument,
  listDocuments,
  uploadDocuments,
} from "../documents";

function makeDoc(over: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: "doc-1",
    agent_id: "agent-1",
    account_id: "acct-1",
    discovery_id: null,
    filename: "report.pdf",
    mime_type: "application/pdf",
    size_bytes: 1024,
    r2_key: "agents/agent-1/documents/doc-1/report.pdf",
    status: "seeded",
    convert_method: "tomarkdown",
    markdown_chars: 500,
    neuron_count: 4,
    source_slug: "sources/report",
    error: null,
    created_at: 0,
    ...over,
  };
}

describe("documents API", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uploadDocuments POSTs a multipart FormData with every file under `files`", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          {
            docId: "doc-1",
            status: "seeded",
            sourceSlug: "sources/a",
            neuronCount: 3,
            error: null,
          },
        ],
      }),
    );

    const a = new File(["alpha"], "a.pdf", { type: "application/pdf" });
    const b = new File(["beta"], "b.docx");
    const results = await uploadDocuments("agent-1", [a, b]);

    expect(fetchUrl(fetchMock)).toContain("/agents/agent-1/documents");
    const init = fetchInit(fetchMock);
    expect(init.method).toBe("POST");

    // RAW multipart body - the browser sets the boundary, so we must NOT set
    // Content-Type ourselves.
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    const files = form.getAll("files");
    expect(files).toHaveLength(2);
    expect((files[0] as File).name).toBe("a.pdf");
    expect((files[1] as File).name).toBe("b.docx");
    expect(new Headers(init.headers).has("content-type")).toBe(false);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("seeded");
  });

  it("listDocuments GETs the documents endpoint and unwraps the list", async () => {
    const doc = makeDoc();
    fetchMock.mockResolvedValue(jsonResponse({ documents: [doc] }));

    const out = await listDocuments("agent-1");
    expect(fetchUrl(fetchMock)).toContain("/agents/agent-1/documents");
    expect(fetchInit(fetchMock).method).toBe("GET");
    expect(out).toEqual([doc]);
  });

  it("deleteDocument DELETEs and appends ?purgeNeurons=true only when requested", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ deleted: true, purgedNeurons: 4 }),
    );

    const purged = await deleteDocument("agent-1", "doc-1", {
      purgeNeurons: true,
    });
    expect(fetchInit(fetchMock).method).toBe("DELETE");
    expect(fetchUrl(fetchMock)).toContain("/agents/agent-1/documents/doc-1");
    expect(fetchUrl(fetchMock)).toContain("purgeNeurons=true");
    expect(purged).toEqual({ deleted: true, purgedNeurons: 4 });

    fetchMock.mockResolvedValue(
      jsonResponse({ deleted: true, purgedNeurons: 0 }),
    );
    await deleteDocument("agent-1", "doc-1");
    expect(fetchUrl(fetchMock)).not.toContain("purgeNeurons");
  });

  it("checkFile gates by extension + size, mirroring the backend accept-list", () => {
    expect(checkFile(new File(["x"], "ok.pdf")).ok).toBe(true);
    // Legacy/unsupported format rejected at the accept-list.
    const legacy = checkFile(new File(["x"], "old.doc"));
    expect(legacy.ok).toBe(false);
    // Oversize rejected (forge a >25MB size without allocating the bytes).
    const big = new File(["x"], "huge.pdf");
    Object.defineProperty(big, "size", { value: 26 * 1024 * 1024 });
    expect(checkFile(big).ok).toBe(false);
  });
});
