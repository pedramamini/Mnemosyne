import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchInit,
  fetchUrl,
  installFetchMock,
  jsonResponse,
} from "../../test/apiMock";
import {
  finalizeDiscovery,
  sendDiscoveryMessage,
  startDiscovery,
} from "../discovery";

const fullSpec = {
  subject: "Acme",
  entityType: "vendor",
  sources: ["acme.com"],
  cadence: "weekly",
  outputFormat: "brief",
  confidence: 0.82,
  facetNotes: {
    subject: "Acme Corp",
    entityType: "vendor",
    sources: "official blog",
    cadence: "weekly",
    outputFormat: "exec brief",
  },
};

describe("discovery API", () => {
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    fetchMock = installFetchMock();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("startDiscovery creates the draft agent then starts the conversation", async () => {
    const calls: string[] = [];
    fetchMock.mockImplementation((url: string) => {
      calls.push(url);
      if (url.endsWith("/agents")) {
        return Promise.resolve(jsonResponse({ id: "agent-9" }));
      }
      return Promise.resolve(
        jsonResponse({ status: "in_progress", spec: null, turns: 0 }),
      );
    });
    const out = await startDiscovery({ name: "Watch", description: "track" });
    expect(out.discoveryId).toBe("agent-9");
    // gate closed while scoping: empty rubric, confidence 0, not ready
    expect(out.state.ready).toBe(false);
    expect(out.state.confidence).toBe(0);
    expect(out.state.rubric.subject).toBe(false);
    expect(calls[0]).toContain("/agents");
    expect(calls[1]).toContain("/agents/agent-9/discovery/start");
  });

  it("sendDiscoveryMessage maps the reply into an assistant turn", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        reply: "Got it - anything else?",
        state: { status: "in_progress", spec: null, turns: 1 },
      }),
    );
    const state = await sendDiscoveryMessage("agent-9", "weekly please");
    expect(fetchUrl(fetchMock)).toContain("/agents/agent-9/discovery/message");
    expect(fetchInit(fetchMock).body).toBe(
      JSON.stringify({ message: "weekly please" }),
    );
    expect(state.messages).toEqual([
      { role: "assistant", content: "Got it - anything else?" },
    ]);
  });

  it("lights the rubric + confidence from a completed spec", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        reply: "All set.",
        state: { status: "complete", spec: fullSpec, turns: 3 },
      }),
    );
    const state = await sendDiscoveryMessage("agent-9", "go");
    expect(state.ready).toBe(true);
    expect(state.confidence).toBe(0.82);
    expect(state.rubric).toEqual({
      subject: true,
      entityType: true,
      sources: true,
      cadence: true,
      outputFormat: true,
    });
  });

  it("lights the rubric + confidence from running progress before the gate clears", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        reply: "Which neighborhoods should it focus on?",
        state: {
          status: "in_progress",
          spec: null,
          turns: 1,
          progress: {
            confidence: 0.45,
            facetNotes: {
              subject: "Austin residential rentals",
              entityType: "a market",
              sources: "",
              cadence: "",
              outputFormat: "",
            },
          },
        },
      }),
    );
    const state = await sendDiscoveryMessage("agent-9", "rentals by ZIP");
    expect(state.ready).toBe(false);
    expect(state.confidence).toBe(0.45);
    expect(state.rubric.subject).toBe(true);
    expect(state.rubric.entityType).toBe(true);
    // Facets the model has not pinned down yet stay off mid-interview.
    expect(state.rubric.sources).toBe(false);
  });

  it("strips a leaked <followup> envelope from the assistant reply", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        reply:
          'What kind of property?\n\n<followup>\n{"questions": ["What kind of property?"]}\n</followup>',
        state: { status: "in_progress", spec: null, turns: 1 },
      }),
    );
    const state = await sendDiscoveryMessage("agent-9", "go");
    expect(state.messages).toEqual([
      { role: "assistant", content: "What kind of property?" },
    ]);
  });

  it("renders no assistant bubble when the reply is empty after stripping", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        reply: '<followup>{"questions": []}</followup>',
        state: { status: "in_progress", spec: null, turns: 1 },
      }),
    );
    const state = await sendDiscoveryMessage("agent-9", "go");
    expect(state.messages).toEqual([]);
  });

  it("treats blank facet notes as unsatisfied even when complete", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        reply: "done",
        state: {
          status: "complete",
          spec: {
            ...fullSpec,
            facetNotes: { ...fullSpec.facetNotes, sources: "  " },
          },
          turns: 3,
        },
      }),
    );
    const state = await sendDiscoveryMessage("agent-9", "go");
    expect(state.rubric.sources).toBe(false);
    expect(state.rubric.subject).toBe(true);
  });

  it("finalizeDiscovery POSTs build and returns the agent id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const out = await finalizeDiscovery("agent-9");
    expect(out.agentId).toBe("agent-9");
    expect(fetchUrl(fetchMock)).toContain("/agents/agent-9/build");
    expect(fetchInit(fetchMock).method).toBe("POST");
  });
});
