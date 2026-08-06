import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { AgentToolCall, FunctionToolDefinition } from "./agent-types";
import { GITORA_ALLOWED_TOOLS, McpManager, McpServerConfig, resolveMcpHeaders, validateMcpHeaders } from "./mcp-manager";
import { SlackContext } from "./types";
import { UserUtils } from "./user-utils";
import { getMessageId, Logger } from "./logger";

export const MCP_TOOL_TIMEOUT_MS = 30_000;
export const TOOL_RESULT_MAX_SIZE = 16_000;
const GITORA_SERVER_NAME = "gitora";
const MCP_PROTOCOL_VERSION = "2025-03-26";

export interface DiscoveredTool {
  definition: FunctionToolDefinition;
  dispatch: (call: AgentToolCall, signal?: AbortSignal) => Promise<{ text: string; isError?: boolean }>;
}

export interface RequestToolSet {
  tools: DiscoveredTool[];
  close(): Promise<void>;
}

function bounded(value: string): string {
  return value.length <= TOOL_RESULT_MAX_SIZE ? value : `${value.slice(0, TOOL_RESULT_MAX_SIZE)}… [truncated]`;
}

function schemaAccepts(schema: Record<string, unknown>, value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (schema.type && schema.type !== "object") return false;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const object = value as Record<string, unknown>;
  if (required.some(key => typeof key !== "string" || !(key in object))) return false;
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, unknown> : {};
  for (const [key, property] of Object.entries(properties)) {
    if (!(key in object) || !property || typeof property !== "object") continue;
    const type = (property as Record<string, unknown>).type;
    if (type === "string" && typeof object[key] !== "string") return false;
    if (type === "number" && typeof object[key] !== "number") return false;
    if (type === "integer" && (!Number.isInteger(object[key]))) return false;
    if (type === "boolean" && typeof object[key] !== "boolean") return false;
    if (type === "array" && !Array.isArray(object[key])) return false;
    const propertySchema = property as Record<string, unknown>;
    if (typeof object[key] === "number") {
      if (typeof propertySchema.minimum === "number" && object[key] < propertySchema.minimum) return false;
      if (typeof propertySchema.maximum === "number" && object[key] > propertySchema.maximum) return false;
    }
    if (typeof object[key] === "string") {
      if (typeof propertySchema.minLength === "number" && object[key].length < propertySchema.minLength) return false;
      if (typeof propertySchema.maxLength === "number" && object[key].length > propertySchema.maxLength) return false;
    }
  }
  if (schema.additionalProperties === false && Object.keys(object).some(key => !(key in properties))) return false;
  return true;
}

function resultText(value: unknown): string {
  if (!value || typeof value !== "object") return bounded(String(value ?? ""));
  const record = value as Record<string, unknown>;
  const content = record.content;
  if (Array.isArray(content)) {
    return bounded(content.map(item => {
      if (!item || typeof item !== "object") return "";
      const itemRecord = item as Record<string, unknown>;
      return typeof itemRecord.text === "string" ? itemRecord.text : JSON.stringify(item);
    }).join("\n"));
  }
  return bounded(JSON.stringify(value));
}

function permittedRemoteTool(serverName: string, server: McpServerConfig, toolName: string): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(toolName)) return false;
  if (serverName === GITORA_SERVER_NAME) {
    return server.type === "http" &&
      GITORA_ALLOWED_TOOLS.includes(toolName as typeof GITORA_ALLOWED_TOOLS[number]);
  }
  const allowed = server.type === "http" || server.type === "sse" ? server.allowedTools : undefined;
  return allowed ? allowed.includes(toolName) : true;
}

/**
 * The installed SDK advertises its newest protocol in initialize. Gitora's
 * Phase 2 contract is intentionally pinned to 2025-03-26, so adapt only the
 * SDK-generated initialize message while retaining the SDK transport/client.
 */
class FixedProtocolTransport implements Transport {
  private initializeSent = false;

  constructor(private readonly delegate: Transport) {}

  get sessionId(): string | undefined { return this.delegate.sessionId; }

  setProtocolVersion(version: string): void {
    this.delegate.setProtocolVersion?.(version);
  }

  async start(): Promise<void> { return this.delegate.start(); }

  async close(): Promise<void> { return this.delegate.close(); }

  async send(message: JSONRPCMessage, options?: Parameters<Transport["send"]>[1]): Promise<void> {
    if (!this.initializeSent && !Array.isArray(message) && "method" in message && message.method === "initialize") {
      this.initializeSent = true;
      const initialize = message as unknown as Record<string, unknown>;
      const params = initialize.params && typeof initialize.params === "object"
        ? initialize.params as Record<string, unknown>
        : {};
      message = { ...initialize, params: { ...params, protocolVersion: MCP_PROTOCOL_VERSION } } as unknown as JSONRPCMessage;
    }
    return this.delegate.send(message, options);
  }

  get onclose(): (() => void) | undefined { return this.delegate.onclose; }
  set onclose(handler: (() => void) | undefined) { this.delegate.onclose = handler; }
  get onerror(): ((error: Error) => void) | undefined { return this.delegate.onerror; }
  set onerror(handler: ((error: Error) => void) | undefined) { this.delegate.onerror = handler; }
  get onmessage(): Transport["onmessage"] { return this.delegate.onmessage; }
  set onmessage(handler: Transport["onmessage"]) { this.delegate.onmessage = handler; }
}

export class McpRequestToolSet implements RequestToolSet {
  readonly tools: DiscoveredTool[];
  private connections: Array<{ client: Client; transport: Transport }> = [];
  private readonly logger = new Logger("McpRequestToolSet");

  private constructor(discovered: DiscoveredTool[]) { this.tools = discovered; }

  static async create(manager: McpManager, context: SlackContext): Promise<McpRequestToolSet> {
    const human = !context.botId && !context.workflowId && context.user !== "USLACKBOT";
    const email = human ? await UserUtils.getUserEmail(context.user) : undefined;
    const role = human ? await UserUtils.getUserRole(context.user) : "none";
    const policyContext = { role, hasHumanIdentity: !!email && human };
    const configured = manager.getServerConfiguration() ?? {};
    const bound = manager.bindForRequest(configured, email);
    const output = new McpRequestToolSet([]);
    for (const [serverName, server] of Object.entries(bound)) {
      const discoveryStartedAt = Date.now();
      try {
        if (server.type === "http" || server.type === "sse") {
          if (server.enabled === false) continue;
          if (serverName === GITORA_SERVER_NAME && server.type !== "http") continue;
          if (serverName === GITORA_SERVER_NAME && (!server.requireHeadersHelper || !server.headersHelper?.trim())) {
            // Gitora's machine-auth contract requires a deployment-owned short-lived credential.
            // Incomplete configuration degrades to ordinary Slack behavior.
            continue;
          }
        }
        const connection = await output.connect(server, serverName);
        if (serverName === GITORA_SERVER_NAME) {
          output.logger.info("MCP connection established", {
            integration: serverName,
            ...(getMessageId() ?? context.messageTs ? { correlationId: getMessageId() ?? context.messageTs } : {}),
            elapsedMs: Date.now() - discoveryStartedAt,
            resultCategory: "connected",
          });
        }
        const listed = await connection.client.listTools(undefined, { maxTotalTimeout: MCP_TOOL_TIMEOUT_MS });
        if (serverName === GITORA_SERVER_NAME) {
          output.logger.info("MCP tools discovered", {
            integration: serverName,
            ...(getMessageId() ?? context.messageTs ? { correlationId: getMessageId() ?? context.messageTs } : {}),
            elapsedMs: Date.now() - discoveryStartedAt,
            resultCategory: "success",
            toolCount: listed.tools.length,
          });
        }
        for (const tool of listed.tools) {
          if (!permittedRemoteTool(serverName, server, tool.name)) continue;
          const name = `mcp__${serverName}__${tool.name}`;
          const decision = await manager.authorizeTool(name, policyContext);
          if (!decision.allowed) continue;
          const schema = tool.inputSchema as Record<string, unknown>;
          output.tools.push({
            definition: {
              type: "function",
              function: { name, description: tool.description, parameters: schema },
            },
            dispatch: async (call: AgentToolCall, signal?: AbortSignal) => {
                const startedAt = Date.now();
                const latest = await manager.authorizeTool(name, policyContext);
                if (!latest.allowed) {
                  if (serverName === GITORA_SERVER_NAME) {
                    output.logger.warn("MCP tool denied", {
                      integration: serverName,
                      ...(getMessageId() ?? context.messageTs ? { correlationId: getMessageId() ?? context.messageTs } : {}),
                      tool: tool.name,
                      elapsedMs: Date.now() - startedAt,
                      resultCategory: "policy_denied",
                    });
                  }
                  return { text: "Tool denied by policy", isError: true };
                }
                if (!permittedRemoteTool(serverName, server, tool.name)) {
                  if (serverName === GITORA_SERVER_NAME) {
                    output.logger.warn("MCP tool denied", {
                      integration: serverName,
                      ...(getMessageId() ?? context.messageTs ? { correlationId: getMessageId() ?? context.messageTs } : {}),
                      tool: tool.name,
                      elapsedMs: Date.now() - startedAt,
                      resultCategory: "policy_denied",
                    });
                  }
                  return { text: "Tool denied by policy", isError: true };
                }
                let args: unknown;
                try { args = JSON.parse(call.function.arguments); } catch {
                  if (serverName === GITORA_SERVER_NAME) {
                    output.logger.warn("MCP tool rejected", {
                      integration: serverName,
                      ...(getMessageId() ?? context.messageTs ? { correlationId: getMessageId() ?? context.messageTs } : {}),
                      tool: tool.name,
                      elapsedMs: Date.now() - startedAt,
                      resultCategory: "invalid_arguments",
                    });
                  }
                  return { text: "Invalid JSON tool arguments", isError: true };
                }
                if (!schemaAccepts(schema, args)) {
                  if (serverName === GITORA_SERVER_NAME) {
                    output.logger.warn("MCP tool rejected", {
                      integration: serverName,
                      ...(getMessageId() ?? context.messageTs ? { correlationId: getMessageId() ?? context.messageTs } : {}),
                      tool: tool.name,
                      elapsedMs: Date.now() - startedAt,
                      resultCategory: "invalid_arguments",
                    });
                  }
                  return { text: "Tool arguments failed schema validation", isError: true };
                }
                const timeout = new AbortController();
                const timer = setTimeout(() => timeout.abort(), MCP_TOOL_TIMEOUT_MS);
                const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
                try {
                  const result = await connection.client.callTool(
                    { name: tool.name, arguments: args as Record<string, unknown> },
                    undefined,
                    { signal: combined, maxTotalTimeout: MCP_TOOL_TIMEOUT_MS },
                  );
                  if (serverName === GITORA_SERVER_NAME) {
                    output.logger.info("MCP tool completed", {
                      integration: serverName,
                      ...(getMessageId() ?? context.messageTs ? { correlationId: getMessageId() ?? context.messageTs } : {}),
                      tool: tool.name,
                      elapsedMs: Date.now() - startedAt,
                      resultCategory: result.isError ? "tool_error" : "success",
                    });
                  }
                  return { text: resultText(result), isError: !!("isError" in result && result.isError) };
                } catch (error) {
                  if (combined.aborted && !signal?.aborted) {
                    try { await connection.client.close(); } catch { try { await connection.transport.close?.(); } catch { /* cleanup is best effort */ } }
                    if (serverName === GITORA_SERVER_NAME) {
                      output.logger.warn("MCP tool failed", {
                        integration: serverName,
                        ...(getMessageId() ?? context.messageTs ? { correlationId: getMessageId() ?? context.messageTs } : {}),
                        tool: tool.name,
                        elapsedMs: Date.now() - startedAt,
                        resultCategory: "timeout",
                      });
                    }
                    return { text: "MCP tool timed out", isError: true };
                  }
                  if (signal?.aborted) throw abortError();
                  const category = safeErrorCategory(error);
                  if (serverName === GITORA_SERVER_NAME) {
                    output.logger.warn("MCP tool failed", {
                      integration: serverName,
                      ...(getMessageId() ?? context.messageTs ? { correlationId: getMessageId() ?? context.messageTs } : {}),
                      tool: tool.name,
                      elapsedMs: Date.now() - startedAt,
                      resultCategory: category,
                    });
                  }
                  return { text: safeToolErrorMessage(serverName, category), isError: true };
                } finally { clearTimeout(timer); }
              },
          });
        }
      } catch (error) {
        // An unavailable server contributes no tools; no unauthenticated fallback.
        if (serverName === GITORA_SERVER_NAME) {
          output.logger.warn("MCP server unavailable", {
            integration: serverName,
            ...(getMessageId() ?? context.messageTs ? { correlationId: getMessageId() ?? context.messageTs } : {}),
            elapsedMs: Date.now() - discoveryStartedAt,
            resultCategory: safeErrorCategory(error),
          });
        }
      }
    }
    return output;
  }

  private async connect(server: McpServerConfig, serverName: string): Promise<{ client: Client; transport: Transport }> {
    let transport: Transport;
    if (!server.type || server.type === "stdio") {
      transport = new StdioClientTransport({ command: server.command, args: server.args, env: server.env, stderr: "pipe" });
    } else {
      if (server.type !== "sse" && server.type !== "http") throw new Error("Unsupported MCP transport");
      const headers = await resolveMcpHeaders(server.headersHelper, server.headers);
      validateMcpHeaders(
        headers,
        serverName === GITORA_SERVER_NAME
          ? { requireHeadersHelper: true, allowedHeaders: ["Authorization"], requiredHeaders: ["Authorization"] }
          : server,
      );
      const requestInit: RequestInit = { headers };
      transport = server.type === "sse"
        ? new SSEClientTransport(new URL(server.url), { requestInit })
        : new StreamableHTTPClientTransport(new URL(server.url), { requestInit });
      if (serverName === GITORA_SERVER_NAME && server.type === "http") {
        (transport as StreamableHTTPClientTransport).setProtocolVersion(MCP_PROTOCOL_VERSION);
      }
    }
    const client = new Client({ name: "slack-ai-agent", version: "2.0.0" });
    const clientTransport = serverName === GITORA_SERVER_NAME && server.type === "http"
      ? new FixedProtocolTransport(transport)
      : transport;
    try {
      await client.connect(clientTransport, { maxTotalTimeout: MCP_TOOL_TIMEOUT_MS });
      this.connections.push({ client, transport: clientTransport });
      return { client, transport: clientTransport };
    } catch (error) {
      try { await client.close(); } catch { try { await clientTransport.close?.(); } catch { /* cleanup is best effort */ } }
      throw error;
    }
  }

  async close(): Promise<void> {
    const connections = this.connections.splice(0);
    await Promise.allSettled(connections.map(async ({ client, transport }) => {
      try { await client.close(); } catch { try { await transport.close?.(); } catch { /* fail closed */ } }
    }));
  }
}

function safeErrorCategory(error: unknown): "authentication" | "invalid_session" | "protocol" | "transport" | "configuration" | "unknown" {
  const message = error instanceof Error ? error.message : "";
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === 401 || code === 403 || /\b401\b|\b403\b|unauthori[sz]ed|forbidden/i.test(message)) return "authentication";
  if (code === 404 || /\b404\b|session/i.test(message)) return "invalid_session";
  if (/protocol|json-rpc|schema|invalid response/i.test(message)) return "protocol";
  if (/header helper|authorization header|mcp headers|configuration/i.test(message)) return "configuration";
  if (error instanceof TypeError || /fetch|network|connect|timeout|stream/i.test(message)) return "transport";
  return "unknown";
}

function safeToolErrorMessage(serverName: string, category: ReturnType<typeof safeErrorCategory>): string {
  if (serverName === GITORA_SERVER_NAME && category === "authentication") return "Gitora authentication failed";
  if (serverName === GITORA_SERVER_NAME && category === "invalid_session") return "Gitora session is no longer valid";
  if (serverName === GITORA_SERVER_NAME && category === "configuration") return "Gitora configuration is unavailable";
  if (category === "protocol") return "MCP protocol error";
  if (category === "transport") return "MCP service unavailable";
  return "MCP tool failed";
}

function abortError(): Error { const error = new Error("Request aborted"); error.name = "AbortError"; return error; }
