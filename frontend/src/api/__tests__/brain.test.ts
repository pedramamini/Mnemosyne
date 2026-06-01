import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchInit,
  fetchUrl,
  installFetchMock,
  jsonResponse,
} from "../../test/apiMock";
import type { CommitDiff } from "../brain";
import {
  brainArchiveUrl,
  deleteBrainFile,
  getCommitDiff,
  getFileAtCommit,
  listBrainFiles,
  listCommits,
  readBrainFile,
  restoreFile,
  writeBrainFile,
} from "../brain";

describe("brain explorer API", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("listBrainFiles GETs the tree", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await listBrainFiles("a1");
    expect(fetchUrl(fetchMock)).toContain("/agents/a1/brain/files");
    expect(fetchInit(fetchMock).method).toBe("GET");
  });

  it("readBrainFile encodes the path query", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ path: "x", content: "c", encoding: "utf8", size: 1 }),
    );
    await readBrainFile("a1", "/brain/notes/a b.md");
    expect(fetchUrl(fetchMock)).toContain(
      "/brain/file?path=%2Fbrain%2Fnotes%2Fa%20b.md",
    );
  });

  it("writeBrainFile PUTs path + content", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ path: "p", commit: "abc" }));
    const out = await writeBrainFile("a1", "/brain/x.md", "hello");
    expect(fetchInit(fetchMock).method).toBe("PUT");
    expect(fetchInit(fetchMock).body).toBe(
      JSON.stringify({ path: "/brain/x.md", content: "hello" }),
    );
    expect(out.commit).toBe("abc");
  });

  it("deleteBrainFile DELETEs with an encoded path and discards the result", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ path: "p", commit: null }));
    await expect(deleteBrainFile("a1", "/brain/x.md")).resolves.toBeUndefined();
    expect(fetchInit(fetchMock).method).toBe("DELETE");
    expect(fetchUrl(fetchMock)).toContain("path=%2Fbrain%2Fx.md");
  });

  it("brainArchiveUrl builds the zip download URL (no fetch)", () => {
    expect(brainArchiveUrl("a1")).toContain(
      "/agents/a1/brain/archive?format=zip",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("brain versioning API", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("listCommits hits whole-brain history with limit", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ entries: [], nextCursor: null }),
    );
    await listCommits("a1", { limit: 20 });
    const url = fetchUrl(fetchMock);
    expect(url).toContain("/agents/a1/brain/history?");
    expect(url).toContain("limit=20");
    expect(url).not.toContain("/history/file");
  });

  it("listCommits switches to the file-history route + passes the cursor", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ entries: [], nextCursor: null }),
    );
    await listCommits("a1", { path: "notes/a.md", cursor: "c2" });
    const url = fetchUrl(fetchMock);
    expect(url).toContain("/brain/history/file?");
    expect(url).toContain("path=notes%2Fa.md");
    expect(url).toContain("cursor=c2");
  });

  it("listCommits omits the query string entirely with no opts", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ entries: [], nextCursor: null }),
    );
    await listCommits("a1");
    expect(fetchUrl(fetchMock).endsWith("/brain/history")).toBe(true);
  });

  it("getCommitDiff returns all files, or filters to one normalized path", async () => {
    const diff: CommitDiff = {
      sha: "deadbeef",
      files: [
        { path: "brain/notes/a.md", additions: 1, deletions: 0, patch: "" },
        { path: "notes/b.md", additions: 2, deletions: 1, patch: "" },
      ],
    };
    fetchMock.mockResolvedValue(jsonResponse(diff));
    expect(await getCommitDiff("a1", "deadbeef")).toHaveLength(2);
    expect(fetchUrl(fetchMock)).toContain("/brain/diff?sha=deadbeef");

    fetchMock.mockResolvedValue(jsonResponse(diff));
    // `/brain/notes/a.md` normalizes to `notes/a.md`, matching the first file.
    const filtered = await getCommitDiff("a1", "deadbeef", "/brain/notes/a.md");
    expect(filtered.map((f) => f.path)).toEqual(["brain/notes/a.md"]);
  });

  it("getFileAtCommit encodes both path and sha", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ path: "p", sha: "s", content: "", truncated: false }),
    );
    await getFileAtCommit("a1", "abc123", "/brain/notes/a.md");
    const url = fetchUrl(fetchMock);
    expect(url).toContain("/brain/file-at?path=%2Fbrain%2Fnotes%2Fa.md");
    expect(url).toContain("sha=abc123");
  });

  it("restoreFile POSTs path + sha", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ path: "p", commit: "new" }));
    const out = await restoreFile("a1", "/brain/x.md", "old");
    expect(fetchInit(fetchMock).method).toBe("POST");
    expect(fetchInit(fetchMock).body).toBe(
      JSON.stringify({ path: "/brain/x.md", sha: "old" }),
    );
    expect(out.commit).toBe("new");
  });
});
