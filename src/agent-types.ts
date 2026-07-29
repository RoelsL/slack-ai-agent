/** Provider-neutral messages used by the application-owned transcript. */
export type AgentMessageRole = "system" | "user" | "assistant" | "tool";

export interface AgentToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AgentMessage {
  role: AgentMessageRole;
  content: string | null;
  tool_calls?: AgentToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface FunctionToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
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
      message: {
        content: Array<{ type: "text"; text: string }>;
        toolCalls?: AgentToolCall[];
      };
    }
  | {
      type: "tool_result";
      toolCallId: string;
      toolName: string;
      result: string;
      isError?: boolean;
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
  tools?: FunctionToolDefinition[];
  signal?: AbortSignal;
}

export interface ProviderToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

export interface ProviderStreamChunk {
  text?: string;
  usage?: ProviderUsage;
  totalCostUsd?: number;
  toolCallDeltas?: ProviderToolCallDelta[];
  done?: boolean;
}

export interface AgentProviderClient {
  streamChat(
    request: ProviderChatRequest,
  ): AsyncGenerator<ProviderStreamChunk, void, unknown>;
}
