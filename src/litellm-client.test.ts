import { LiteLLMClient, normalizeLiteLLMBaseUrl } from "./litellm-client";

function responseFor(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const completed = (usage = { input_tokens: 2, output_tokens: 3 }, cost?: number) =>
  `data: ${JSON.stringify({ type: "response.completed", response: { usage, ...(cost !== undefined && { response_cost: cost }) } })}\n\n`;

describe("LiteLLMClient Responses API", () => {
  afterEach(() => jest.restoreAllMocks());

  it("normalizes the version path once and translates input/instructions", async () => {
    expect(normalizeLiteLLMBaseUrl("https://proxy.example/v1///")).toBe("https://proxy.example/v1");
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      responseFor(`data: {"type":"response.output_text.delta","delta":"hi"}\n\n${completed()}`),
    );
    const client = new LiteLLMClient({ baseUrl: "https://proxy.example/v1/", apiKey: "secret", model: "deployment", requestTimeoutMs: 1000 });
    const chunks = [];
    for await (const chunk of client.streamChat({
      model: "deployment",
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "answer" },
      ],
    })) chunks.push(chunk);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://proxy.example/v1/responses",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
        body: JSON.stringify({
          model: "deployment",
          input: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "answer" },
          ],
          instructions: "rules",
          stream: true,
        }),
      }),
    );
    expect(chunks).toEqual([
      { text: "hi" },
      { done: true, usage: { inputTokens: 2, outputTokens: 3 } },
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).not.toHaveProperty("stream_options");
  });

  it("translates chat-style function tools and preserves call/result item order", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(responseFor(completed()));
    const client = new LiteLLMClient({ baseUrl: "http://proxy", apiKey: "x", model: "m", requestTimeoutMs: 1000 });
    const tools = [{ type: "function" as const, function: { name: "local__read", description: "Read", parameters: { type: "object" } } }];
    for await (const _chunk of client.streamChat({
      model: "m",
      messages: [
        { role: "user", content: "read" },
        { role: "assistant", content: null, tool_calls: [{ id: "provider-call", type: "function", function: { name: "local__read", arguments: "{\"path\":\"x\"}" } }] },
        { role: "tool", tool_call_id: "provider-call", name: "local__read", content: "result" },
      ],
      tools,
    })) { /* consume */ }
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.tools).toEqual([{ type: "function", name: "local__read", description: "Read", parameters: { type: "object" } }]);
    expect(body.input).toEqual([
      { role: "user", content: "read" },
      { type: "function_call", call_id: "provider-call", name: "local__read", arguments: "{\"path\":\"x\"}" },
      { type: "function_call_output", call_id: "provider-call", output: "result" },
    ]);
  });

  it("handles split SSE payloads, text deltas, and terminal usage/cost", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(": keepalive\n\ndata: {\"type\":\"response.output_text."));
        controller.enqueue(encoder.encode("delta"));
        controller.enqueue(encoder.encode("\",\"delta\":\"a\"}\n\n"));
        controller.enqueue(encoder.encode(completed({ input_tokens: 4, output_tokens: 5 }, 0.004)));
        controller.close();
      },
    });
    jest.spyOn(global, "fetch").mockResolvedValue(new Response(stream));
    const client = new LiteLLMClient({ baseUrl: "http://proxy", apiKey: "x", model: "m", requestTimeoutMs: 1000 });
    const chunks = [];
    for await (const chunk of client.streamChat({ model: "m", messages: [] })) chunks.push(chunk);
    expect(chunks).toEqual([
      { text: "a" },
      { done: true, usage: { inputTokens: 4, outputTokens: 5 }, totalCostUsd: 0.004 },
    ]);
  });

  it("parses canonical fragmented function calls and propagates call_id", async () => {
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_item", call_id: "provider-call", name: "lookup", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_item", call_id: "provider-call", delta: "{\"q\":" },
      { type: "response.function_call_arguments.delta", item_id: "fc_item", call_id: "provider-call", delta: "\"value\"}" },
      { type: "response.function_call_arguments.done", item_id: "fc_item", call_id: "provider-call", name: "lookup", arguments: "{\"q\":\"value\"}" },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_item", call_id: "provider-call", name: "lookup", arguments: "{\"q\":\"value\"}" } },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } },
    ];
    jest.spyOn(global, "fetch").mockResolvedValue(responseFor(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
    const client = new LiteLLMClient({ baseUrl: "http://proxy", apiKey: "x", model: "m", requestTimeoutMs: 1000 });
    const chunks = [];
    for await (const chunk of client.streamChat({ model: "m", messages: [] })) chunks.push(chunk);
    expect(chunks).toContainEqual({ toolCallDeltas: [{ index: 0, id: "provider-call", name: "lookup" }] });
    expect(chunks).toContainEqual({ toolCallDeltas: [{ index: 0, id: "provider-call", name: "lookup", argumentsDelta: "{\"q\":" }] });
    expect(chunks).toContainEqual({ toolCallDeltas: [{ index: 0, id: "provider-call", name: "lookup", argumentsDelta: "\"value\"}" }] });
    expect(chunks[chunks.length - 1]).toEqual({ done: true, usage: { inputTokens: 1, outputTokens: 2 } });
  });

  it("emits arguments delivered only by the final function-call event", async () => {
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_item", call_id: "provider-call", name: "lookup", arguments: "" } },
      { type: "response.function_call_arguments.done", item_id: "fc_item", call_id: "provider-call", name: "lookup", arguments: "{\"q\":\"value\"}" },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } },
    ];
    jest.spyOn(global, "fetch").mockResolvedValue(responseFor(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
    const client = new LiteLLMClient({ baseUrl: "http://proxy", apiKey: "x", model: "m", requestTimeoutMs: 1000 });
    const chunks = [];
    for await (const chunk of client.streamChat({ model: "m", messages: [] })) chunks.push(chunk);
    expect(chunks).toContainEqual({ toolCallDeltas: [{ index: 0, id: "provider-call", name: "lookup", argumentsDelta: "{\"q\":\"value\"}" }] });
  });

  it("rejects provider failures and malformed data without exposing opaque payloads", async () => {
    const client = new LiteLLMClient({ baseUrl: "http://proxy", apiKey: "x", model: "m", requestTimeoutMs: 1000 });
    jest.spyOn(global, "fetch").mockResolvedValue(responseFor(`data: ${JSON.stringify({ type: "response.failed", error: { message: "prompt-secret" } })}\n\n`));
    await expect(async () => { for await (const _chunk of client.streamChat({ model: "m", messages: [] })) { /* consume */ } }).rejects.toThrow("LiteLLM response failed");
    await expect(async () => { for await (const _chunk of client.streamChat({ model: "m", messages: [] })) { /* consume */ } }).rejects.not.toThrow("prompt-secret");

    jest.spyOn(global, "fetch").mockResolvedValue(responseFor("data: tool-output-secret\n\n"));
    await expect(async () => { for await (const _chunk of client.streamChat({ model: "m", messages: [] })) { /* consume */ } }).rejects.toThrow("malformed stream data");
    await expect(async () => { for await (const _chunk of client.streamChat({ model: "m", messages: [] })) { /* consume */ } }).rejects.not.toThrow("tool-output-secret");
  });

  it("rejects a stream that ends without response.completed", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(responseFor('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
    const client = new LiteLLMClient({ baseUrl: "http://proxy", apiKey: "secret", model: "m", requestTimeoutMs: 1000 });
    await expect(async () => { for await (const _chunk of client.streamChat({ model: "m", messages: [] })) { /* consume */ } }).rejects.toThrow("stream ended before completion");
  });
});
