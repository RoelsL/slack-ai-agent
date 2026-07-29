import {
  AgentMessage,
  AgentProviderClient,
  AgentStreamEvent,
  ProviderUsage,
} from "./agent-types";
import { config, provisionThreadWorkspace, destroyThreadWorkspace } from "./config";
import { LiteLLMClient } from "./litellm-client";
import { Logger } from "./logger";
import { ConversationSession, SlackContext } from "./types";
import { RequestMode } from "./request-mode";

export const DEFAULT_SESSION_MAX_AGE_MS = 16 * 60 * 60 * 1000;
const MAX_TURNS = 10;

interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier: number;
}

export class AgentHandler {
  private sessions = new Map<string, ConversationSession>();
  private logger = new Logger("AgentHandler");
  private readonly client: AgentProviderClient;
  readonly retryOptions: RetryOptions = {
    maxRetries: 3,
    initialDelayMs: 2000,
    backoffMultiplier: 1.5,
  };

  constructor(client?: AgentProviderClient) {
    this.client = client ?? new LiteLLMClient(config.litellm);
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || "direct"}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const sessionKey = this.getSessionKey(userId, channelId, threadTs);
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      workingDirectory: provisionThreadWorkspace(sessionKey),
      lastActivity: new Date(),
      history: [],
    };
    this.sessions.set(sessionKey, session);
    return session;
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal) {
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        signal.addEventListener("abort", cleanup, { once: true });
        setTimeout(cleanup, ms);
      }
    });
  }

  async simpleRetry<T>(
    operation: () => Promise<T>,
    onRetry?: (attempt: number) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; attempt <= this.retryOptions.maxRetries; attempt++) {
      try {
        if (signal?.aborted) throw abortError();
        return await operation();
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (attempt === this.retryOptions.maxRetries) throw error;
        const delay = this.retryOptions.initialDelayMs * Math.pow(this.retryOptions.backoffMultiplier, attempt);
        this.logger.warn(`Provider attempt failed; retrying in ${delay}ms`, { attempt: attempt + 1 });
        onRetry?.(attempt + 1);
        if (signal) {
          await this.sleep(delay, signal);
        } else {
          await this.sleep(delay);
        }
      }
    }
    throw new Error("Retry loop exhausted");
  }

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    _workingDirectory?: string,
    _slackContext?: SlackContext,
    onRetry?: (attempt: number) => void,
    systemPrompt?: string,
    requestMode?: RequestMode,
  ): AsyncGenerator<AgentStreamEvent, void, unknown> {
    const targetSession = session;
    const priorHistory = targetSession ? targetSession.history : [];
    const messages = this.buildHistory(priorHistory, systemPrompt, prompt);
    const requestedModel = requestMode?.model;
    const model = requestedModel === config.litellm.model ? requestedModel : config.litellm.model;
    if (requestMode && (requestMode.effort || requestMode.fast || (requestedModel && requestedModel !== model))) {
      this.logger.info("Ignoring unsupported provider request mode fields", {
        modelIgnored: !!requestedModel && requestedModel !== model,
        effortIgnored: !!requestMode.effort,
        fastIgnored: !!requestMode.fast,
      });
    }

    let output = "";
    let usage: ProviderUsage | undefined;
    let totalCostUsd: number | undefined;
    await this.simpleRetry(async () => {
      output = "";
      usage = undefined;
      totalCostUsd = undefined;
      for await (const chunk of this.client.streamChat({
        model,
        messages,
        signal: abortController?.signal,
      })) {
        if (chunk.text) output += chunk.text;
        if (chunk.usage) usage = chunk.usage;
        if (chunk.totalCostUsd !== undefined) {
          totalCostUsd = chunk.totalCostUsd;
        }
      }
    }, onRetry, abortController?.signal);

    if (abortController?.signal.aborted) throw abortError();
    if (targetSession) {
      targetSession.history = this.commitHistory(messages, output);
      targetSession.lastActivity = new Date();
    }
    if (output) {
      yield { type: "assistant", message: { content: [{ type: "text", text: output }] } };
    }
    yield {
      type: "result",
      subtype: "success",
      result: output,
      usage,
      totalCostUsd,
    };
  }

  private buildHistory(history: AgentMessage[], systemPrompt: string | undefined, prompt: string): AgentMessage[] {
    const turns = history.filter(message => message.role !== "system");
    const system = systemPrompt === undefined
      ? history.find(message => message.role === "system")
      : { role: "system" as const, content: systemPrompt };
    const recent = turns.slice(-((MAX_TURNS - 1) * 2));
    return [...(system ? [system] : []), ...recent, { role: "user", content: prompt }];
  }

  private commitHistory(messages: AgentMessage[], output: string): AgentMessage[] {
    const withoutCurrentUser = messages.slice(0, -1);
    const committed = [...withoutCurrentUser, messages[messages.length - 1], { role: "assistant" as const, content: output }];
    const system = committed.find(message => message.role === "system");
    const turns = committed
      .filter(message => message.role !== "system")
      .slice(-MAX_TURNS * 2);
    return [...(system ? [system] : []), ...turns];
  }

  cleanupInactiveSessions(maxAge: number = DEFAULT_SESSION_MAX_AGE_MS): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        destroyThreadWorkspace(key);
      }
    }
  }
}

function abortError(): Error {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}
