/**
 * Deterministic `ai`-SDK mock models for the MNEMO-15 harness tests.
 *
 * The vitest-pool-workers DO tests can't swap the `AI` binding on a
 * runtime-constructed Durable Object, so they inject one of these via
 * `MnemosyneAgent.testModelOverride` (a `runInDurableObject` field set). That
 * keeps the agentic loop hermetic - no real inference, no module mocking - while
 * still exercising the real `streamText` / `generateText` loop end to end.
 *
 * Filename does not end in ".test.ts", so vitest never collects it as a test
 * suite (the pool only runs the ".test.ts" files under test/).
 */
import type {
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { ResolvedModel } from "../src/llm/getModel.ts";
import { DEFAULT_WORKERS_AI_MODEL } from "../src/llm/types.ts";

/**
 * Nested provider-shape usage (`LanguageModelV3Usage`). The SDK normalizes this
 * into the flat `LanguageModelUsage` that `recordUsage` reads, so a turn meters a
 * small, deterministic token count.
 */
const USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
};

/** The secret-free config the resolver would return; pins to the free default. */
const CONFIG = {
  provider: "workers-ai",
  model: DEFAULT_WORKERS_AI_MODEL,
} as const;

/**
 * Streaming model (`doStream`) for the interactive `onChatMessage` loop. Emits a
 * single text part = `reply`, then a `finish` with a deterministic usage report.
 */
export function streamingModel(reply: string): ResolvedModel {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: reply },
    { type: "text-end", id: "0" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: USAGE,
    },
  ];
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks,
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
      }),
    }),
  });
  return { model, config: { ...CONFIG } };
}

/** Non-streaming model (`doGenerate`) for the headless `runHeadless` loop. */
export function generateModel(reply: string): ResolvedModel {
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: reply }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: USAGE,
      warnings: [],
    }),
  });
  return { model, config: { ...CONFIG } };
}

/**
 * Like {@link generateModel}, but RECORDS the prompt the loop fed it on each
 * `doGenerate` call. Lets a test assert the loop ran on the right input (e.g. the
 * MNEMO-46 SMS reply built from the counterparty's transcript) - the returned
 * `calls` array fills as the loop invokes the model.
 */
export function capturingGenerateModel(reply: string): {
  model: ResolvedModel;
  calls: { prompt: unknown }[];
} {
  const calls: { prompt: unknown }[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls.push({ prompt: options.prompt });
      return {
        content: [{ type: "text", text: reply }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
        warnings: [],
      };
    },
  });
  return { model: { model, config: { ...CONFIG } }, calls };
}

/**
 * Two-step `doGenerate` model for the tool-loop integration test: the first
 * call emits a single tool call (`toolName` with `input`), the second - after
 * the SDK runs the tool and feeds the result back - emits the final text and
 * stops. This drives the real `generateText` loop through one tool round-trip.
 */
export function toolThenTextModel(
  toolName: string,
  input: Record<string, unknown>,
  finalText: string,
): ResolvedModel {
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName,
              input: JSON.stringify(input),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage: USAGE,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: finalText }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
        warnings: [],
      };
    },
  });
  return { model, config: { ...CONFIG } };
}

/**
 * Two-step `doGenerate` model for the MNEMO-18 terminator-loop test: the first
 * call emits one research tool call (`toolName` with `input`); the second - after
 * the SDK feeds the result back - emits a `submitFinalReport` (terminator) tool
 * call carrying `report`. The run's `stopWhen` then ends the loop the moment the
 * terminator fires, so this drives a clean, deliberate deep-research exit.
 */
export function toolThenTerminatorModel(
  toolName: string,
  input: Record<string, unknown>,
  report: Record<string, unknown>,
): ResolvedModel {
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName,
              input: JSON.stringify(input),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage: USAGE,
          warnings: [],
        };
      }
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-2",
            toolName: "submitFinalReport",
            input: JSON.stringify(report),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage: USAGE,
        warnings: [],
      };
    },
  });
  return { model, config: { ...CONFIG } };
}

/** Concatenate the text parts of a UI message (drops non-text parts). */
export function uiText(message: UIMessage | undefined): string {
  if (!message) return "";
  return message.parts
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}
