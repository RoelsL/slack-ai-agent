import {
  ProviderChatRequest,
  ProviderStreamChunk,
  ProviderUsage,
} from "./agent-types";

export interface LiteLLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  requestTimeoutMs: number;
}

export class LiteLLMProviderError extends Error {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = "LiteLLMProviderError";
  }
}

export class LiteLLMTimeoutError extends LiteLLMProviderError {
  constructor() {
    super("LiteLLM request timed out");
    this.name = "TimeoutError";
  }
}

/** Return a base URL ending in exactly one `/v1`. */
export function normalizeLiteLLMBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function usageFromWire(value: unknown): ProviderUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  return {
    inputTokens: input,
    outputTokens: output,
    ...(typeof usage.cache_read_input_tokens === "number" && {
      cacheReadInputTokens: usage.cache_read_input_tokens,
    }),
    ...(typeof usage.cache_creation_input_tokens === "number" && {
      cacheCreationInputTokens: usage.cache_creation_input_tokens,
    }),
  };
}

function getDeltaText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const choices = (value as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") {
    return undefined;
  }
  const delta = (choices[0] as Record<string, unknown>).delta;
  if (!delta || typeof delta !== "object") return undefined;
  const content = (delta as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
}

function getToolCallDeltas(value: unknown): ProviderStreamChunk["toolCallDeltas"] {
  if (!value || typeof value !== "object") return undefined;
  const choices = (value as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return undefined;
  const delta = (choices[0] as Record<string, unknown>).delta;
  if (!delta || typeof delta !== "object") return undefined;
  const calls = (delta as Record<string, unknown>).tool_calls;
  if (!Array.isArray(calls)) return undefined;
  const result = calls.flatMap((call): NonNullable<ProviderStreamChunk["toolCallDeltas"]> => {
    if (!call || typeof call !== "object") return [];
    const record = call as Record<string, unknown>;
    if (typeof record.index !== "number") return [];
    const fn = record.function;
    const functionRecord = fn && typeof fn === "object" ? fn as Record<string, unknown> : undefined;
    return [{
      index: record.index,
      ...(typeof record.id === "string" && { id: record.id }),
      ...(typeof functionRecord?.name === "string" && { name: functionRecord.name }),
      ...(typeof functionRecord?.arguments === "string" && { argumentsDelta: functionRecord.arguments }),
    }];
  });
  return result.length ? result : undefined;
}

function costFromWire(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const candidate = record.response_cost ?? record.total_cost;
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

/**
 * Small typed fetch client for the OpenAI-compatible LiteLLM endpoint. It
 * deliberately has no knowledge of tools, MCP, or provider-specific options.
 */
export class LiteLLMClient {
  private readonly endpoint: string;

  constructor(private readonly config: LiteLLMConfig) {
    if (!config.baseUrl.trim()) throw new Error("Missing LiteLLM base URL");
    if (!config.apiKey.trim()) throw new Error("Missing LiteLLM API key");
    if (!config.model.trim()) throw new Error("Missing LiteLLM model");
    if (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs <= 0) {
      throw new Error("Invalid LiteLLM request timeout");
    }
    this.endpoint = `${normalizeLiteLLMBaseUrl(config.baseUrl)}/chat/completions`;
  }

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncGenerator<ProviderStreamChunk, void, unknown> {
    const timeoutController = new AbortController();
    const timer = setTimeout(
      () => timeoutController.abort(),
      this.config.requestTimeoutMs,
    );
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutController.signal])
      : timeoutController.signal;

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (request.signal?.aborted) throw abortError();
      if (timeoutController.signal.aborted) throw new LiteLLMTimeoutError();
      throw providerError(error);
    }

    try {
      if (!response.ok) {
        throw new LiteLLMProviderError(`LiteLLM request failed (${response.status})`);
      }
      if (!response.body) throw new LiteLLMProviderError("LiteLLM returned no stream");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const events = splitSseEvents(buffer);
        buffer = events.remainder;
        for (const event of events.events) {
          const parsed = parseSseEvent(event);
          if (parsed.done) {
            finished = true;
            yield { done: true };
            break;
          }
          if (parsed.value) yield parsed.value;
        }
        if (finished || done) {
          if (!finished && buffer.trim()) {
            const parsed = parseSseEvent(buffer + "\n\n");
            if (parsed.done) {
              finished = true;
              yield { done: true };
            }
            else if (parsed.value) yield parsed.value;
          }
          break;
        }
      }
      if (!finished) {
        throw new LiteLLMProviderError(
          "LiteLLM stream ended before completion",
        );
      }
    } catch (error) {
      if (request.signal?.aborted) throw abortError();
      if (timeoutController.signal.aborted) throw new LiteLLMTimeoutError();
      if (error instanceof LiteLLMProviderError) throw error;
      throw providerError(error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function abortError(): Error {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

function providerError(error: unknown): LiteLLMProviderError {
  // Do not include upstream response text: it can contain prompts or secrets.
  return new LiteLLMProviderError(
    error instanceof Error && error.name === "TypeError"
      ? "LiteLLM provider connection failed"
      : "LiteLLM provider request failed",
  );
}

function splitSseEvents(input: string): { events: string[]; remainder: string } {
  const events: string[] = [];
  let start = 0;
  for (;;) {
    const lf = input.indexOf("\n\n", start);
    const crlf = input.indexOf("\r\n\r\n", start);
    let boundary = -1;
    let length = 0;
    if (lf >= 0 && (crlf < 0 || lf < crlf)) {
      boundary = lf;
      length = 2;
    } else if (crlf >= 0) {
      boundary = crlf;
      length = 4;
    }
    if (boundary < 0) break;
    events.push(input.slice(start, boundary));
    start = boundary + length;
  }
  return { events, remainder: input.slice(start) };
}

function parseSseEvent(event: string): { done: boolean; value?: ProviderStreamChunk } {
  const dataLines = event
    .split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart());
  if (dataLines.length === 0) return { done: false };
  const data = dataLines.join("\n").trim();
  if (!data) return { done: false };
  if (data === "[DONE]") return { done: true };
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw new LiteLLMProviderError("LiteLLM returned malformed stream data");
  }
  const record = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const text = getDeltaText(json);
  const toolCallDeltas = getToolCallDeltas(json);
  const usage = usageFromWire(record.usage);
  const totalCostUsd = costFromWire(json);
  if (!text && !toolCallDeltas?.length && !usage && totalCostUsd === undefined) return { done: false };
  return {
    done: false,
    value: {
      ...(text !== undefined && { text }),
      ...(toolCallDeltas && { toolCallDeltas }),
      ...(usage && { usage }),
      ...(totalCostUsd !== undefined && { totalCostUsd }),
    },
  };
}
