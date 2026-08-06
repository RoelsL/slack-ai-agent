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
import { McpManager } from "./mcp-manager";
import { McpRequestToolSet, DiscoveredTool, RequestToolSet, TOOL_RESULT_MAX_SIZE } from "./mcp-client";
import { CustomActionRegistry } from "./custom-actions/registry";
import { UserUtils } from "./user-utils";
import { LocalReadTool } from "./local-file-tool";

export const DEFAULT_SESSION_MAX_AGE_MS = 16 * 60 * 60 * 1000;
const MAX_TURNS = 10;
export const MAX_AGENTIC_TURNS = 8;
const PACKAGE_PAGE_SIZE = 5;
const LARGE_PACKAGE_INVENTORY_RESPONSE =
  "This project has {count} installed packages, so I cannot return every package in one Slack response. I can help with a specific package, version, dependency type, security issue, or provide a bounded summary. Please narrow the request.";
export type RequestToolSetFactory = (manager: McpManager, context: SlackContext) => Promise<RequestToolSet>;

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

  constructor(
    client?: AgentProviderClient,
    private readonly mcpManager?: McpManager,
    private readonly customActions?: CustomActionRegistry,
    private readonly requestToolSetFactory: RequestToolSetFactory = (manager, context) => McpRequestToolSet.create(manager, context),
  ) {
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
    if (requestMode && requestedModel && requestedModel !== model) {
      this.logger.info("Ignoring unsupported provider request mode fields", {
        modelIgnored: !!requestedModel && requestedModel !== model,
      });
    }

    let output = "";
    let boundedPackageInventory: number | undefined;
    let usage: ProviderUsage | undefined;
    let totalCostUsd: number | undefined;
    let workingMessages = [...messages];
    let toolSet: { tools: DiscoveredTool[]; close(): Promise<void> } = { tools: [], close: async () => undefined };
    try {
      if (this.mcpManager && _slackContext) {
        toolSet = await this.requestToolSetFactory(this.mcpManager, _slackContext);
      }
      if (_slackContext && this.mcpManager) {
        const local = await LocalReadTool.create(
          this.mcpManager,
          _slackContext,
          _workingDirectory ?? targetSession?.workingDirectory ?? "",
          _slackContext.uploads ?? [],
        );
        if (local) toolSet.tools.push(local);
      }
      if (this.customActions && _slackContext) {
        const actionTools = this.customActions.createFunctionTools({
          userId: _slackContext.user,
          channel: _slackContext.channel,
          channelType: _slackContext.channelType,
          threadTs: _slackContext.threadTs,
          messageTs: _slackContext.messageTs ?? "",
          messageText: _slackContext.messageText,
          threadUserText: _slackContext.threadUserText,
          workflowId: _slackContext.workflowId,
          botId: _slackContext.botId,
          reactionKey: _slackContext.reactionKey,
          workingDirectory: _slackContext.workingDirectory,
        });
        const actionRole = !_slackContext.botId && !_slackContext.workflowId
          ? await UserUtils.getUserRole(_slackContext.user)
          : "none";
        const allowedActions = this.mcpManager
          ? (await Promise.all(actionTools.map(async tool => [tool, await this.mcpManager!.authorizeTool(tool.definition.function.name, {
              role: actionRole,
              hasHumanIdentity: !_slackContext.botId && !_slackContext.workflowId && !!_slackContext.user,
            })] as const))).filter(([, decision]) => decision.allowed).map(([tool]) => tool)
          : actionTools;
        toolSet.tools.push(...allowedActions.map(tool => ({ definition: tool.definition, dispatch: async (call: import("./agent-types").AgentToolCall) => {
          if (this.mcpManager) {
            const decision = await this.mcpManager.authorizeTool(tool.definition.function.name, {
              role: actionRole,
              hasHumanIdentity: !_slackContext.botId && !_slackContext.workflowId && !!_slackContext.user,
            });
            if (!decision.allowed) return { text: "Tool denied by policy", isError: true };
          }
          try { return await tool.execute(JSON.parse(call.function.arguments)); }
          catch { return { text: "Invalid JSON tool arguments", isError: true }; }
        } })));
      }

      const broadPackageRequest = isBroadPackageInventoryRequest(prompt);
      for (let turn = 0; turn < MAX_AGENTIC_TURNS; turn++) {
        if (abortController?.signal.aborted) throw abortError();
        let turnText = "";
        const deltas = new Map<number, { id: string; name: string; args: string }>();
        await this.simpleRetry(async () => {
          turnText = "";
          deltas.clear();
          let attemptUsage: ProviderUsage | undefined;
          let attemptCostUsd: number | undefined;
          let attemptText = "";
          for await (const chunk of this.client.streamChat({
            model, messages: [...workingMessages],
            tools: toolSet.tools.length ? toolSet.tools.map(tool => tool.definition) : undefined,
            signal: abortController?.signal,
          })) {
            if (chunk.text) { turnText += chunk.text; attemptText += chunk.text; }
            if (chunk.usage) attemptUsage = addUsage(attemptUsage, chunk.usage);
            if (chunk.totalCostUsd !== undefined && Number.isFinite(chunk.totalCostUsd)) {
              attemptCostUsd = (attemptCostUsd ?? 0) + chunk.totalCostUsd;
            }
            for (const delta of chunk.toolCallDeltas ?? []) {
              const current = deltas.get(delta.index) ?? { id: `call_${delta.index}`, name: "", args: "" };
              if (delta.id) current.id = delta.id;
              if (delta.name) current.name = delta.name;
              if (delta.argumentsDelta) current.args += delta.argumentsDelta;
              deltas.set(delta.index, current);
            }
          }
          // Only merge telemetry and visible text after the complete stream
          // attempt succeeds. Failed/retried attempts are discarded.
          output += attemptText;
          if (attemptUsage) usage = addUsage(usage, attemptUsage);
          if (attemptCostUsd !== undefined) totalCostUsd = (totalCostUsd ?? 0) + attemptCostUsd;
        }, onRetry, abortController?.signal);
        const calls = [...deltas.values()].map(call => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.args } }));
        if (turnText || calls.length) {
          yield { type: "assistant", message: { content: turnText ? [{ type: "text", text: turnText }] : [], ...(calls.length && { toolCalls: calls }) } };
        }
        if (!calls.length) {
          // Persist this exact final provider turn. `output` is UI-only
          // aggregate text and must never be used to reconstruct history.
          if (turnText) workingMessages.push({ role: "assistant", content: turnText });
          break;
        }
        workingMessages.push({ role: "assistant", content: turnText || null, tool_calls: calls });
        for (const call of calls) {
          if (abortController?.signal.aborted) throw abortError();
          const tool = toolSet.tools.find(candidate => candidate.definition.function.name === call.function.name);
          let result: { text: string; isError?: boolean };
          if (!tool) result = { text: "Unknown or unauthorized tool", isError: true };
          else {
            try { result = await tool.dispatch(call, abortController?.signal); }
            catch (error) { if (error instanceof Error && error.name === "AbortError") throw error; result = { text: "Tool execution failed", isError: true }; }
          }
          const boundedResult = result.text.length > TOOL_RESULT_MAX_SIZE ? `${result.text.slice(0, TOOL_RESULT_MAX_SIZE)}… [truncated]` : result.text;
          yield { type: "tool_result", toolCallId: call.id, toolName: call.function.name, result: boundedResult, isError: result.isError };
          workingMessages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: boundedResult });
          const packageCount = largePackageInventoryCount(
            call.function.name,
            result,
            turn,
            broadPackageRequest,
          );
          if (packageCount !== undefined) {
            boundedPackageInventory = packageCount;
            break;
          }
        }
        if (boundedPackageInventory !== undefined) break;
      }
    } finally {
      await toolSet.close();
    }

    if (abortController?.signal.aborted) throw abortError();
    if (boundedPackageInventory !== undefined) {
      const response = LARGE_PACKAGE_INVENTORY_RESPONSE.replace(
        "{count}",
        String(boundedPackageInventory),
      );
      output = response;
      workingMessages.push({ role: "assistant", content: response });
      yield { type: "assistant", message: { content: [{ type: "text", text: response }] } };
    }
    if (targetSession) {
      targetSession.history = this.commitHistory(workingMessages);
      targetSession.lastActivity = new Date();
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
    const recent = this.trimTranscript(turns, MAX_TURNS - 1);
    return [...(system ? [system] : []), ...recent, { role: "user", content: prompt }];
  }

  private commitHistory(messages: AgentMessage[]): AgentMessage[] {
    const committed = [...messages];
    const system = committed.find(message => message.role === "system");
    const turns = this.trimTranscript(committed
      .filter(message => message.role !== "system")
      , MAX_TURNS);
    return [...(system ? [system] : []), ...turns];
  }

  private trimTranscript(messages: AgentMessage[], maxTurns: number): AgentMessage[] {
    const groups: AgentMessage[][] = [];
    for (const message of messages) {
      if (message.role === "user" || groups.length === 0) groups.push([]);
      groups[groups.length - 1].push(message);
    }
    return groups.slice(-maxTurns).flat();
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

function isBroadPackageInventoryRequest(prompt: string): boolean {
  return /\b(all|every|complete|entire|full|list)\b[\s\S]{0,80}\b(packages?|dependencies|inventory)\b/i.test(prompt) ||
    /\b(packages?|dependencies|inventory)\b[\s\S]{0,80}\b(all|every|complete|entire|full)\b/i.test(prompt);
}

function largePackageInventoryCount(
  toolName: string,
  result: { text: string; isError?: boolean },
  turn: number,
  broadRequest: boolean,
): number | undefined {
  if (!broadRequest || result.isError || !toolName.endsWith("list_project_packages")) return undefined;

  let payload: unknown;
  try { payload = JSON.parse(result.text); } catch { return undefined; }
  if (!payload || typeof payload !== "object") return undefined;
  const data = payload as {
    totalCount?: unknown;
    moreResultsAvailable?: unknown;
    packages?: unknown;
  };
  if (typeof data.totalCount !== "number" || !Number.isFinite(data.totalCount) || data.totalCount < 0) return undefined;
  if (data.moreResultsAvailable !== true) return undefined;

  const returnedCount = Array.isArray(data.packages) ? data.packages.length : PACKAGE_PAGE_SIZE;
  const remainingFetches = Math.max(0, MAX_AGENTIC_TURNS - turn - 1);
  const maxFetchable = returnedCount + remainingFetches * PACKAGE_PAGE_SIZE;
  return data.totalCount > maxFetchable ? Math.floor(data.totalCount) : undefined;
}

function abortError(): Error {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

function addUsage(current: ProviderUsage | undefined, next: ProviderUsage): ProviderUsage {
  return {
    inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
    ...(current?.cacheReadInputTokens !== undefined || next.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: (current?.cacheReadInputTokens ?? 0) + (next.cacheReadInputTokens ?? 0) }
      : {}),
    ...(current?.cacheCreationInputTokens !== undefined || next.cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens: (current?.cacheCreationInputTokens ?? 0) + (next.cacheCreationInputTokens ?? 0) }
      : {}),
  };
}
