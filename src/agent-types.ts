/** Provider-neutral messages used by the application-owned transcript. */
export type AgentMessageRole = "system" | "user" | "assistant";

export interface AgentMessage {
  role: AgentMessageRole;
  content: string;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export type AgentStreamEvent =
  | {
      type: "assistant";
      message: { content: Array<{ type: "text"; text: string }> };
    }
  | {
      type: "result";
      subtype: "success" | "error";
      result: string;
      usage?: ProviderUsage;
      totalCostUsd?: number;
    };

export interface ProviderChatRequest {
  model: string;
  messages: AgentMessage[];
  signal?: AbortSignal;
}

export interface ProviderStreamChunk {
  text?: string;
  usage?: ProviderUsage;
  totalCostUsd?: number;
  done?: boolean;
}

export interface AgentProviderClient {
  streamChat(
    request: ProviderChatRequest,
  ): AsyncGenerator<ProviderStreamChunk, void, unknown>;
}
