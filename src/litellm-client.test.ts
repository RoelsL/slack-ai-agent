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

describe("LiteLLMClient", () => {
  afterEach(() => jest.restoreAllMocks());

  it("normalizes the version path once and sends only text request fields", async () => {
    expect(normalizeLiteLLMBaseUrl("https://proxy.example/v1///")).toBe(
      "https://proxy.example/v1",
    );
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(responseFor('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'));
    const client = new LiteLLMClient({
      baseUrl: "https://proxy.example/v1/",
      apiKey: "secret",
      model: "deployment",
      requestTimeoutMs: 1000,
    });
    const chunks = [];
    for await (const chunk of client.streamChat({
      model: "deployment",
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "hello" },
      ],
    })) chunks.push(chunk);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://proxy.example/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
        body: JSON.stringify({
          model: "deployment",
          messages: [
            { role: "system", content: "rules" },
            { role: "user", content: "hello" },
          ],
          stream: true,
          stream_options: { include_usage: true },
        }),
      }),
    );
    expect(chunks).toEqual([{ text: "hi" }, { done: true }]);
  });

  it("handles split payloads, multiple events, comments, and terminal usage", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(": keepalive\n\ndata: {\"choices\":[{"));
        controller.enqueue(encoder.encode("\"delta\":{\"content\":\"a\"}}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3}}\n\n"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    jest.spyOn(global, "fetch").mockResolvedValue(new Response(stream));
    const client = new LiteLLMClient({ baseUrl: "http://proxy", apiKey: "x", model: "m", requestTimeoutMs: 1000 });
    const chunks = [];
    for await (const chunk of client.streamChat({ model: "m", messages: [] })) chunks.push(chunk);
    expect(chunks).toEqual([
      { text: "a" },
      { usage: { inputTokens: 2, outputTokens: 3 } },
      { done: true },
    ]);
  });

  it("rejects malformed nonempty data without exposing its contents", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(responseFor("data: not-json-secret\n\n"));
    const client = new LiteLLMClient({ baseUrl: "http://proxy", apiKey: "x", model: "m", requestTimeoutMs: 1000 });
    await expect(async () => {
      for await (const _chunk of client.streamChat({ model: "m", messages: [] })) { /* consume */ }
    }).rejects.toThrow("malformed stream data");
    await expect(async () => {
      for await (const _chunk of client.streamChat({ model: "m", messages: [] })) { /* consume */ }
    }).rejects.not.toThrow("not-json-secret");
  });

  it("rejects a stream that ends without an SSE completion event", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      responseFor('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
    );
    const client = new LiteLLMClient({
      baseUrl: "http://proxy",
      apiKey: "secret",
      model: "m",
      requestTimeoutMs: 1000,
    });
    await expect(async () => {
      for await (const _chunk of client.streamChat({ model: "m", messages: [] })) {
        // Consume the stream.
      }
    }).rejects.toThrow("stream ended before completion");
  });

  it("extracts optional LiteLLM cost metadata", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      responseFor(
        'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2},"response_cost":0.004}\n\ndata: [DONE]\n\n',
      ),
    );
    const client = new LiteLLMClient({
      baseUrl: "http://proxy",
      apiKey: "secret",
      model: "m",
      requestTimeoutMs: 1000,
    });
    const chunks = [];
    for await (const chunk of client.streamChat({ model: "m", messages: [] })) {
      chunks.push(chunk);
    }
    expect(chunks).toContainEqual({
      usage: { inputTokens: 1, outputTokens: 2 },
      totalCostUsd: 0.004,
    });
  });
});
