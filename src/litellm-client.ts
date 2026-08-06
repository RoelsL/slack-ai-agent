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
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  const inputDetails = usage.input_token_details;
  const cachedInput = inputDetails && typeof inputDetails === "object"
    ? (inputDetails as Record<string, unknown>).cached_tokens
    : undefined;
  return {
    inputTokens: input,
    outputTokens: output,
    ...((typeof cachedInput === "number" || typeof usage.cache_read_input_tokens === "number") && {
      cacheReadInputTokens: typeof cachedInput === "number"
        ? cachedInput
        : usage.cache_read_input_tokens as number,
    }),
    ...(typeof usage.cache_creation_input_tokens === "number" && {
      cacheCreationInputTokens: usage.cache_creation_input_tokens,
    }),
  };
}

function costFromWire(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const candidate of [record.response_cost, record.total_cost, record.cost]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  for (const nested of [record.response, record.metadata]) {
    const cost = costFromWire(nested);
    if (cost !== undefined) return cost;
  }
  return undefined;
}

interface ResponsesInputMessage {
  role: "user" | "assistant";
  content: string;
}

interface ResponsesFunctionCallInput {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponsesFunctionCallOutputInput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesFunctionCallInput
  | ResponsesFunctionCallOutputInput;

function translateMessages(messages: ProviderChatRequest["messages"]): {
  input: ResponsesInputItem[];
  instructions?: string;
} {
  const instructions = messages
    .filter(message => message.role === "system" && typeof message.content === "string")
    .map(message => message.content as string)
    .filter(Boolean)
    .join("\n\n");
  const input: ResponsesInputItem[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user" || message.role === "assistant") {
      if (typeof message.content === "string") {
        input.push({ role: message.role, content: message.content });
      }
      for (const call of message.tool_calls ?? []) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      continue;
    }
    if (message.role === "tool" && typeof message.tool_call_id === "string") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: typeof message.content === "string" ? message.content : "",
      });
    }
  }

  return {
    input,
    ...(instructions && { instructions }),
  };
}

function translateTools(tools: NonNullable<ProviderChatRequest["tools"]>): Array<Record<string, unknown>> {
  return tools.map(tool => ({
    type: "function",
    name: tool.function.name,
    ...(tool.function.description !== undefined && { description: tool.function.description }),
    parameters: tool.function.parameters,
  }));
}

interface FunctionCallState {
  index: number;
  itemId?: string;
  id?: string;
  name?: string;
  arguments: string;
}

interface ResponsesStreamState {
  calls: Map<number, FunctionCallState>;
  indexes: Map<string, number>;
  nextIndex: number;
}

function newResponsesStreamState(): ResponsesStreamState {
  return { calls: new Map(), indexes: new Map(), nextIndex: 0 };
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function functionCallDelta(
  value: Record<string, unknown>,
  state: ResponsesStreamState,
  item?: Record<string, unknown>,
  argumentsDelta?: string,
): ProviderStreamChunk["toolCallDeltas"] {
  const source = item ?? value;
  if (source.type !== "function_call") return undefined;
  const itemId = typeof source.id === "string"
    ? source.id
    : typeof value.item_id === "string" ? value.item_id : undefined;
  const callId = typeof source.call_id === "string"
    ? source.call_id
    : typeof value.call_id === "string" ? value.call_id : undefined;
  const key = itemId ? `item:${itemId}` : callId ? `call:${callId}` : undefined;
  let index = key ? state.indexes.get(key) : undefined;
  if (index === undefined && typeof value.output_index === "number") index = value.output_index;
  if (index === undefined) index = state.nextIndex++;
  state.nextIndex = Math.max(state.nextIndex, index + 1);
  const current = state.calls.get(index) ?? { index, arguments: "" };
  if (itemId) {
    current.itemId = itemId;
    state.indexes.set(`item:${itemId}`, index);
  }
  if (callId) {
    current.id = callId;
    state.indexes.set(`call:${callId}`, index);
  }
  if (typeof source.name === "string") current.name = source.name;
  if (typeof source.arguments === "string" && argumentsDelta === undefined) {
    current.arguments = source.arguments;
  }
  if (argumentsDelta !== undefined) current.arguments += argumentsDelta;
  state.calls.set(index, current);
  const delta = {
    index,
    ...(current.id && { id: current.id }),
    ...(current.name && { name: current.name }),
    ...(argumentsDelta !== undefined && argumentsDelta.length > 0 && { argumentsDelta }),
  };
  return [delta];
}

function finalFunctionCallDelta(
  value: Record<string, unknown>,
  state: ResponsesStreamState,
  item?: Record<string, unknown>,
): ProviderStreamChunk["toolCallDeltas"] {
  const source = item ?? value;
  const finalArguments = typeof source.arguments === "string" ? source.arguments : undefined;
  const itemId = typeof source.id === "string"
    ? source.id
    : typeof value.item_id === "string" ? value.item_id : undefined;
  const callId = typeof source.call_id === "string"
    ? source.call_id
    : typeof value.call_id === "string" ? value.call_id : undefined;
  const key = itemId ? `item:${itemId}` : callId ? `call:${callId}` : undefined;
  const index = key ? state.indexes.get(key) : undefined;
  const existingArguments = index === undefined ? "" : state.calls.get(index)?.arguments ?? "";
  const before = functionCallDelta(value, state, item);
  if (!before?.length) return before;
  const current = state.calls.get(before[0].index)!;
  let missing = "";
  if (finalArguments !== undefined && finalArguments !== existingArguments) {
    missing = finalArguments.startsWith(existingArguments)
      ? finalArguments.slice(existingArguments.length)
      : finalArguments;
    current.arguments = finalArguments;
  }
  return [{
    ...before[0],
    ...(missing && { argumentsDelta: missing }),
  }];
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
    this.endpoint = `${normalizeLiteLLMBaseUrl(config.baseUrl)}/responses`;
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
          ...translateMessages(request.messages),
          ...(request.tools && request.tools.length > 0 && { tools: translateTools(request.tools) }),
          stream: true,
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
      const streamState = newResponsesStreamState();
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const events = splitSseEvents(buffer);
        buffer = events.remainder;
        for (const event of events.events) {
           const parsed = parseSseEvent(event, streamState);
           if (parsed.done) {
             finished = true;
             if (parsed.value) yield parsed.value;
             else yield { done: true };
             break;
          }
          if (parsed.value) yield parsed.value;
        }
        if (finished || done) {
          if (!finished && buffer.trim()) {
            const parsed = parseSseEvent(buffer + "\n\n", streamState);
            if (parsed.done) {
              finished = true;
              if (parsed.value) yield parsed.value;
              else yield { done: true };
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

function parseSseEvent(
  event: string,
  state: ResponsesStreamState,
): { done: boolean; value?: ProviderStreamChunk } {
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
  const eventType = typeof record.type === "string" ? record.type : "";
  if (eventType === "error" || eventType === "response.failed" || eventType === "response.incomplete" || eventType.endsWith(".error")) {
    throw new LiteLLMProviderError("LiteLLM response failed");
  }
  if (eventType === "response.completed") {
    const response = record.response;
    const responseRecord = recordFrom(response);
    const usage = usageFromWire(responseRecord?.usage);
    const totalCostUsd = costFromWire(responseRecord) ?? costFromWire(record);
    return {
      done: true,
      value: {
        done: true,
        ...(usage && { usage }),
        ...(totalCostUsd !== undefined && { totalCostUsd }),
      },
    };
  }

  let text: string | undefined;
  if (eventType === "response.output_text.delta" && typeof record.delta === "string") {
    text = record.delta;
  }

  let toolCallDeltas: ProviderStreamChunk["toolCallDeltas"];
  if (eventType === "response.function_call_arguments.delta" && typeof record.delta === "string") {
    toolCallDeltas = functionCallDelta({ ...record, type: "function_call", call_id: record.call_id }, state, undefined, record.delta);
  } else if (eventType === "response.function_call_arguments.done") {
    toolCallDeltas = finalFunctionCallDelta({ ...record, type: "function_call", call_id: record.call_id }, state);
  } else if (eventType === "response.output_item.added" || eventType === "response.output_item.done") {
    const item = recordFrom(record.item);
    if (item?.type === "function_call") {
      toolCallDeltas = eventType.endsWith("done")
        ? finalFunctionCallDelta(record, state, item)
        : functionCallDelta(record, state, item);
    }
  }

  const usage = usageFromWire(record.usage);
  const totalCostUsd = costFromWire(record);
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
