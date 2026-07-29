jest.mock("./config", () => ({
  ...jest.requireActual("./config"),
  provisionThreadWorkspace: (sessionKey: string) =>
    `/tmp/slack-ai-agent/workspaces/${sessionKey}`,
  destroyThreadWorkspace: jest.fn(),
  config: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      signingSecret: "test-secret",
    },
    litellm: { baseUrl: "http://localhost:4000/v1", apiKey: "test-key", model: "test-model", requestTimeoutMs: 120000 },
    slackWorkspaceUrl: "https://test.slack.com",
    baseDirectory: "/tmp/slack-ai-agent",
    persistDir: "/tmp/test-persist",
    debug: false,
  },
}));

jest.mock("./user-utils", () => ({
  UserUtils: {
    getUserRole: jest.fn().mockResolvedValue("member"),
  },
}));

jest.mock("./validation-agent", () => ({
  loadSubagentDefinitions: jest.fn(() => ({})),
}));

import {
  AgentHandler,
  DEFAULT_SESSION_MAX_AGE_MS,
} from "./agent-handler";
import {
  destroyThreadWorkspace,
  buildSandboxFilesystem,
  SANDBOX_FILESYSTEM,
  SANDBOX_NETWORK,
} from "./config";
import fs from "fs";
import os from "os";
import path from "path";
import type { ProviderChatRequest, ProviderStreamChunk } from "./agent-types";
import type { ConversationSession } from "./types";

async function collect<T>(stream: AsyncGenerator<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

interface FakeClient {
  streamChat: jest.MockedFunction<
    (request: ProviderChatRequest) => AsyncGenerator<ProviderStreamChunk>
  >;
}

function createHandler(
  client?: FakeClient,
  retryOverrides?: {
    maxRetries?: number;
    initialDelayMs?: number;
    backoffMultiplier?: number;
  },
): AgentHandler {
  const handler = new AgentHandler(client);

  if (retryOverrides) {
    handler.retryOptions.maxRetries = retryOverrides.maxRetries ?? 3;
    handler.retryOptions.initialDelayMs = retryOverrides.initialDelayMs ?? 1;
    handler.retryOptions.backoffMultiplier =
      retryOverrides.backoffMultiplier ?? 1;
  }

  return handler;
}

describe("AgentHandler", () => {
  function streamOf(...chunks: ProviderStreamChunk[]): AsyncGenerator<ProviderStreamChunk> {
    return (async function* () {
      yield* chunks;
    })();
  }

  function fakeClient(
    streams: Array<AsyncGenerator<ProviderStreamChunk> | Error>,
  ): FakeClient {
    return {
      streamChat: jest.fn(async function* (_request: ProviderChatRequest) {
        const next = streams.shift();
        if (next instanceof Error) throw next;
        if (next) yield* next;
      }),
    };
  }

  function completedSession(handler: AgentHandler): ConversationSession {
    return handler.createSession("U1", "C1", "T1");
  }

  it("uses committed history on the second request", async () => {
    const client = fakeClient([
      streamOf({ text: "first" }),
      streamOf({ text: "second" }),
    ]);
    const handler = createHandler(client);
    const session = completedSession(handler);

    await collect(handler.streamQuery("one", session, undefined, undefined, undefined, undefined, "rules"));
    await collect(handler.streamQuery("two", session, undefined, undefined, undefined, undefined, "rules"));

    expect(client.streamChat.mock.calls[1][0].messages).toEqual([
      { role: "system", content: "rules" },
      { role: "user", content: "one" },
      { role: "assistant", content: "first" },
      { role: "user", content: "two" },
    ]);
  });

  it("replaces a changed system message", async () => {
    const client = fakeClient([streamOf({ text: "one" }), streamOf({ text: "two" })]);
    const handler = createHandler(client);
    const session = completedSession(handler);

    await collect(handler.streamQuery("one", session, undefined, undefined, undefined, undefined, "old"));
    await collect(handler.streamQuery("two", session, undefined, undefined, undefined, undefined, "new"));

    expect(client.streamChat.mock.calls[1][0].messages).toEqual([
      { role: "system", content: "new" },
      { role: "user", content: "one" },
      { role: "assistant", content: "one" },
      { role: "user", content: "two" },
    ]);
    expect(session.history.filter(message => message.role === "system")).toHaveLength(1);
  });

  it("does not retry aborts or commit partial output", async () => {
    const controller = new AbortController();
    const client: FakeClient = {
      streamChat: jest.fn(async function* (_request: ProviderChatRequest) {
        yield { text: "partial" };
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }),
    };
    const handler = createHandler(client);
    const session = completedSession(handler);

    await expect(collect(handler.streamQuery("query", session, controller))).rejects.toThrow("aborted");
    expect(client.streamChat).toHaveBeenCalledTimes(1);
    expect(session.history).toEqual([]);
  });

  it("retries streaming failures without duplicating the current user", async () => {
    const client = fakeClient([
      new Error("temporary"),
      streamOf({ text: "recovered" }),
    ]);
    const handler = createHandler(client, { maxRetries: 1, initialDelayMs: 1, backoffMultiplier: 1 });
    const session = completedSession(handler);

    await collect(handler.streamQuery("once", session));
    expect(client.streamChat).toHaveBeenCalledTimes(2);
    expect(client.streamChat.mock.calls[0][0].messages).toEqual([
      { role: "user", content: "once" },
    ]);
    expect(client.streamChat.mock.calls[1][0].messages).toEqual([
      { role: "user", content: "once" },
    ]);
    expect(session.history).toEqual([
      { role: "user", content: "once" },
      { role: "assistant", content: "recovered" },
    ]);
  });

  it("aborts retry sleep without issuing another provider call", async () => {
    const controller = new AbortController();
    const client = fakeClient([new Error("temporary"), streamOf({ text: "late" })]);
    const handler = createHandler(client, {
      maxRetries: 1,
      initialDelayMs: 100,
      backoffMultiplier: 1,
    });
    const session = completedSession(handler);
    const retry = jest.fn();

    const pending = collect(
      handler.streamQuery(
        "query",
        session,
        controller,
        undefined,
        undefined,
        retry,
      ),
    );
    await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(client.streamChat).toHaveBeenCalledTimes(1);
    expect(session.history).toEqual([]);
  });

  it("uses only an exact configured model and ignores unsupported mode fields", async () => {
    const client = fakeClient([streamOf({ text: "ok" }), streamOf({ text: "ok" })]);
    const handler = createHandler(client);
    const session = completedSession(handler);

    await collect(handler.streamQuery("x", session, undefined, undefined, undefined, undefined, undefined, {
      model: "other-model",
      effort: "high",
      fast: true,
    }));
    await collect(handler.streamQuery("y", session, undefined, undefined, undefined, undefined, undefined, {
      model: "test-model",
      effort: "low",
      fast: true,
    }));

    expect(client.streamChat.mock.calls[0][0].model).toBe("test-model");
    expect(client.streamChat.mock.calls[1][0].model).toBe("test-model");
    expect(client.streamChat.mock.calls[0][0]).not.toHaveProperty("effort");
    expect(client.streamChat.mock.calls[0][0]).not.toHaveProperty("fast");
  });

  it("keeps only nine prior pairs in a request and ten after commit", async () => {
    const client = fakeClient([streamOf({ text: "new-answer" })]);
    const handler = createHandler(client);
    const session = completedSession(handler);
    session.history = [{ role: "system", content: "rules" }];
    for (let i = 1; i <= 10; i++) {
      session.history.push({ role: "user", content: `user-${i}` });
      session.history.push({ role: "assistant", content: `assistant-${i}` });
    }

    await collect(handler.streamQuery("current", session));
    const request = client.streamChat.mock.calls[0][0].messages;
    expect(request).toHaveLength(1 + 18 + 1);
    expect(request[1]).toEqual({ role: "user", content: "user-2" });
    expect(request[request.length - 1]).toEqual({
      role: "user",
      content: "current",
    });
    expect(session.history).toHaveLength(1 + 20);
    expect(session.history[1]).toEqual({ role: "user", content: "user-2" });
    expect(session.history[session.history.length - 1]).toEqual({
      role: "assistant",
      content: "new-answer",
    });
  });

  describe("getSessionKey", () => {
    let handler: AgentHandler;
    beforeEach(() => {
      handler = createHandler();
    });

    it("builds key from userId, channelId, and threadTs", () => {
      expect(handler.getSessionKey("U1", "C2", "111.222")).toBe(
        "U1-C2-111.222",
      );
    });

    it('uses "direct" when threadTs is undefined', () => {
      expect(handler.getSessionKey("U1", "C2")).toBe("U1-C2-direct");
    });

    it('uses "direct" when threadTs is empty string', () => {
      expect(handler.getSessionKey("U1", "C2", "")).toBe("U1-C2-direct");
    });
  });

  describe("session lifecycle", () => {
    let handler: AgentHandler;
    beforeEach(() => {
      handler = createHandler();
    });

    it("returns undefined for unknown session", () => {
      expect(handler.getSession("U1", "C2", "111.222")).toBeUndefined();
    });

    it("creates and retrieves a session", () => {
      const session = handler.createSession("U1", "C2", "111.222");
      expect(session.userId).toBe("U1");
      expect(session.channelId).toBe("C2");
      expect(session.threadTs).toBe("111.222");
      expect(session.lastActivity).toBeInstanceOf(Date);
      expect(session.workingDirectory).toContain("workspaces/U1-C2-111.222");

      const retrieved = handler.getSession("U1", "C2", "111.222");
      expect(retrieved).toBe(session);
    });

    it("creates DM session without threadTs", () => {
      const session = handler.createSession("U1", "C2");
      expect(session.threadTs).toBeUndefined();
      expect(handler.getSession("U1", "C2")).toBe(session);
    });

    it("overwrites session with same key", () => {
      const first = handler.createSession("U1", "C2", "111.222");
      const second = handler.createSession("U1", "C2", "111.222");
      expect(handler.getSession("U1", "C2", "111.222")).toBe(second);
      expect(second).not.toBe(first);
    });

    it("keeps sessions with different keys separate", () => {
      const s1 = handler.createSession("U1", "C1", "1.1");
      const s2 = handler.createSession("U1", "C2", "1.1");
      expect(handler.getSession("U1", "C1", "1.1")).toBe(s1);
      expect(handler.getSession("U1", "C2", "1.1")).toBe(s2);
    });
  });

  describe("cleanupInactiveSessions", () => {
    let handler: AgentHandler;
    beforeEach(() => {
      handler = createHandler();
      jest.mocked(destroyThreadWorkspace).mockClear();
    });

    it("removes sessions older than maxAge", () => {
      const session = handler.createSession("U1", "C1", "1.1");
      // Backdate the session
      session.lastActivity = new Date(Date.now() - 60_000);

      handler.cleanupInactiveSessions(30_000); // 30s max age
      expect(handler.getSession("U1", "C1", "1.1")).toBeUndefined();
      expect(destroyThreadWorkspace).toHaveBeenCalledWith("U1-C1-1.1");
    });

    it("keeps sessions younger than maxAge", () => {
      const session = handler.createSession("U1", "C1", "1.1");
      session.lastActivity = new Date(); // just now

      handler.cleanupInactiveSessions(30_000);
      expect(handler.getSession("U1", "C1", "1.1")).toBe(session);
    });

    it("keeps sessions younger than default maxAge", () => {
      const session = handler.createSession("U1", "C1", "1.1");
      session.lastActivity = new Date(
        Date.now() - DEFAULT_SESSION_MAX_AGE_MS + 60_000,
      );

      handler.cleanupInactiveSessions();
      expect(handler.getSession("U1", "C1", "1.1")).toBe(session);
    });

    it("removes sessions older than default maxAge", () => {
      const session = handler.createSession("U1", "C1", "1.1");
      session.lastActivity = new Date(
        Date.now() - DEFAULT_SESSION_MAX_AGE_MS - 60_000,
      );

      handler.cleanupInactiveSessions();
      expect(handler.getSession("U1", "C1", "1.1")).toBeUndefined();
    });

    it("handles mix of stale and fresh sessions", () => {
      const stale = handler.createSession("U1", "C1", "1.1");
      stale.lastActivity = new Date(Date.now() - 60_000);

      const fresh = handler.createSession("U2", "C2", "2.2");
      fresh.lastActivity = new Date();

      handler.cleanupInactiveSessions(30_000);
      expect(handler.getSession("U1", "C1", "1.1")).toBeUndefined();
      expect(handler.getSession("U2", "C2", "2.2")).toBe(fresh);
    });

    it("handles empty sessions map", () => {
      expect(() => handler.cleanupInactiveSessions()).not.toThrow();
    });
  });

  describe("simpleRetry", () => {
    let handler: AgentHandler;
    beforeEach(() => {
      handler = createHandler(undefined, {
        maxRetries: 3,
        initialDelayMs: 1, // 1ms delays for fast tests
        backoffMultiplier: 1,
      });
    });

    it("returns on first success", async () => {
      const op = jest.fn().mockResolvedValue("ok");
      const result = await handler.simpleRetry(op);
      expect(result).toBe("ok");
      expect(op).toHaveBeenCalledTimes(1);
    });

    it("retries on failure and eventually succeeds", async () => {
      const op = jest
        .fn()
        .mockRejectedValueOnce(new Error("fail1"))
        .mockRejectedValueOnce(new Error("fail2"))
        .mockResolvedValue("ok");

      const result = await handler.simpleRetry(op);
      expect(result).toBe("ok");
      expect(op).toHaveBeenCalledTimes(3);
    });

    it("throws after exhausting all retries", async () => {
      const op = jest.fn().mockRejectedValue(new Error("always fails"));

      await expect(handler.simpleRetry(op)).rejects.toThrow(
        "always fails",
      );
      // 1 initial + 3 retries = 4 calls
      expect(op).toHaveBeenCalledTimes(4);
    });

    it("immediately re-throws AbortError without retrying", async () => {
      const abortError = new Error("Aborted");
      abortError.name = "AbortError";
      const op = jest.fn().mockRejectedValue(abortError);

      await expect(handler.simpleRetry(op)).rejects.toThrow("Aborted");
      expect(op).toHaveBeenCalledTimes(1);
    });

    it("calls onRetry callback with correct attempt number", async () => {
      const op = jest
        .fn()
        .mockRejectedValueOnce(new Error("fail"))
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValue("ok");

      const onRetry = jest.fn();
      await handler.simpleRetry(op, onRetry);

      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenNthCalledWith(1, 1);
      expect(onRetry).toHaveBeenNthCalledWith(2, 2);
    });

    it("does not call onRetry on first success", async () => {
      const op = jest.fn().mockResolvedValue("ok");
      const onRetry = jest.fn();
      await handler.simpleRetry(op, onRetry);
      expect(onRetry).not.toHaveBeenCalled();
    });

    it("applies exponential backoff delays", async () => {
      const customHandler = createHandler(undefined, {
        maxRetries: 2,
        initialDelayMs: 10,
        backoffMultiplier: 2,
      });

      const sleepSpy = jest
        .spyOn(customHandler, "sleep")
        .mockResolvedValue(undefined);

      const op = jest
        .fn()
        .mockRejectedValueOnce(new Error("fail"))
        .mockRejectedValueOnce(new Error("fail"))
        .mockResolvedValue("ok");

      await customHandler.simpleRetry(op);

      // attempt 0 fails → delay = 10 * 2^0 = 10ms
      // attempt 1 fails → delay = 10 * 2^1 = 20ms
      expect(sleepSpy).toHaveBeenCalledTimes(2);
      expect(sleepSpy).toHaveBeenNthCalledWith(1, 10);
      expect(sleepSpy).toHaveBeenNthCalledWith(2, 20);
    });
  });
});


describe("SANDBOX_FILESYSTEM", () => {
  // Regression guard: the `bq` CLI refreshes its OAuth token cache into
  // ~/.config/gcloud on every call, so the dir must be writable, not just
  // readable, or bq dies with a read-only filesystem error.
  it("lets bq both read and write its gcloud token cache in place", () => {
    expect(SANDBOX_FILESYSTEM.allowRead).toContain("~/.config/gcloud");
    expect(SANDBOX_FILESYSTEM.allowWrite).toContain("~/.config/gcloud");
  });

  it("keeps the rest of $HOME unreadable so repo secrets stay hidden", () => {
    expect(SANDBOX_FILESYSTEM.denyRead).toContain("~/");
    // Legacy helper data is retained for later tool sessions.
    expect(SANDBOX_FILESYSTEM.allowWrite).toContain("/tmp/slack-ai-agent");
  });

  it("scopes bash writes to the thread workspace cwd", () => {
    const threadWorkspace = "/tmp/slack-ai-agent/workspaces/U1-C2-1.1";
    const rules = buildSandboxFilesystem(threadWorkspace);
    expect(rules.allowWrite).toEqual([threadWorkspace, "~/.config/gcloud"]);
    expect(rules.denyRead).toEqual(SANDBOX_FILESYSTEM.denyRead);
  });

  // A future local tool runner may persist oversized outputs under
  // ~/.claude/projects/<slugified-cwd>/ and tells the agent to read them
  // back from there. The slug is per thread workspace, so other threads'
  // session artifacts stay hidden behind the $HOME denyRead.
  it("lets the agent read back its own persisted oversized tool outputs", () => {
    const rules = buildSandboxFilesystem(
      "/tmp/slack-ai-agent/workspaces/U1-C2-1.1",
    );
    expect(rules.allowRead).toEqual([
      ".",
      "~/.config/gcloud",
      "~/.claude/projects/-tmp-slack-ai-agent-workspaces-U1-C2-1-1",
    ]);
  });

  // A future runner may slug its resolved cwd, so when the workspace path contains a
  // symlink (macOS /tmp → /private/tmp) the persisted outputs land under the
  // physical path's slug, which must be readable too.
  it("also lets the agent read the project dir of a symlink-resolved cwd", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "ws-target-"));
    const link = `${target}-link`;
    fs.symlinkSync(target, link);
    try {
      const rules = buildSandboxFilesystem(link);
      expect(rules.allowRead).toContain(
        `~/.claude/projects/${link.replace(/[^a-zA-Z0-9]/g, "-")}`,
      );
      expect(rules.allowRead).toContain(
        `~/.claude/projects/${fs
          .realpathSync(link)
          .replace(/[^a-zA-Z0-9]/g, "-")}`,
      );
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("SANDBOX_NETWORK", () => {
  // Deferred network rules include endpoints the future `bq` and
  // `aws` CLIs the data skills shell out to need these endpoints allowlisted:
  // `bq` refreshes its OAuth token against googleapis.com, and `aws` reads
  // instance-profile credentials from the IMDS link-local address.
  it("allows the Google Cloud and AWS endpoints the data CLIs need", () => {
    expect(SANDBOX_NETWORK.allowedDomains).toContain("*.googleapis.com");
    expect(SANDBOX_NETWORK.allowedDomains).toContain("*.amazonaws.com");
    expect(SANDBOX_NETWORK.allowedDomains).toContain("169.254.169.254");
  });
});
