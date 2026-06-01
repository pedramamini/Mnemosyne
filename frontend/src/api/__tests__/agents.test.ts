import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchInit,
  fetchUrl,
  installFetchMock,
  jsonResponse,
} from "../../test/apiMock";
import {
  createAgent,
  deleteAgent,
  getAgent,
  getBrainStats,
  listAgents,
  updateAgent,
} from "../agents";

describe("agents registry API", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("listAgents GETs /agents", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await listAgents();
    expect(fetchUrl(fetchMock).endsWith("/agents")).toBe(true);
  });

  it("getAgent encodes the id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "a/b" }));
    await getAgent("a/b");
    expect(fetchUrl(fetchMock)).toContain("/agents/a%2Fb");
  });

  it("createAgent POSTs the create body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "a1" }, { status: 201 }));
    await createAgent({ name: "Watch", template: "vendor" });
    expect(fetchInit(fetchMock).method).toBe("POST");
    expect(fetchInit(fetchMock).body).toBe(
      JSON.stringify({ name: "Watch", template: "vendor" }),
    );
  });

  it("updateAgent PATCHes the encoded id with the patch body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "a1" }));
    await updateAgent("a1", { description: null });
    expect(fetchInit(fetchMock).method).toBe("PATCH");
    expect(fetchUrl(fetchMock)).toContain("/agents/a1");
    expect(fetchInit(fetchMock).body).toBe(
      JSON.stringify({ description: null }),
    );
  });

  it("deleteAgent DELETEs the encoded id", async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, { status: 204 }));
    await deleteAgent("a/b");
    expect(fetchInit(fetchMock).method).toBe("DELETE");
    expect(fetchUrl(fetchMock)).toContain("/agents/a%2Fb");
  });

  it("getBrainStats reads the brain-size metric for an agent", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ neurons: 5, synapses: 9, dangling: 2 }),
    );
    expect(await getBrainStats("a1")).toEqual({
      neurons: 5,
      synapses: 9,
      dangling: 2,
    });
    expect(fetchUrl(fetchMock)).toContain("/agents/a1/brain/size");
  });
});
