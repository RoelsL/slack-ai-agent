import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AgentToolCall, FunctionToolDefinition } from "./agent-types";
import { McpManager, McpServerConfig, resolveMcpHeaders } from "./mcp-manager";
import { SlackContext } from "./types";
import { UserUtils } from "./user-utils";

export const MCP_TOOL_TIMEOUT_MS = 30_000;
export const TOOL_RESULT_MAX_SIZE = 16_000;

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

export class McpRequestToolSet implements RequestToolSet {
  readonly tools: DiscoveredTool[];
  private connections: Array<{ client: Client; transport: Transport }> = [];

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
      try {
        const connection = await output.connect(server, serverName);
        const listed = await connection.client.listTools();
        for (const tool of listed.tools) {
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
              const latest = await manager.authorizeTool(name, policyContext);
              if (!latest.allowed) return { text: "Tool denied by policy", isError: true };
              let args: unknown;
              try { args = JSON.parse(call.function.arguments); } catch { return { text: "Invalid JSON tool arguments", isError: true }; }
              if (!schemaAccepts(schema, args)) return { text: "Tool arguments failed schema validation", isError: true };
              const timeout = new AbortController();
              const timer = setTimeout(() => timeout.abort(), MCP_TOOL_TIMEOUT_MS);
              const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
              try {
                const result = await connection.client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }, undefined, { signal: combined });
                return { text: resultText(result), isError: !!("isError" in result && result.isError) };
              } catch (error) {
                if (combined.aborted && !signal?.aborted) {
                  try { await connection.client.close(); } catch { try { await connection.transport.close?.(); } catch { /* cleanup is best effort */ } }
                  return { text: "MCP tool timed out", isError: true };
                }
                if (signal?.aborted) throw abortError();
                return { text: "MCP tool failed", isError: true };
              } finally { clearTimeout(timer); }
            },
          });
        }
      } catch {
        // An unavailable server contributes no tools; no unauthenticated fallback.
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
      const requestInit: RequestInit = { headers };
      transport = server.type === "sse"
        ? new SSEClientTransport(new URL(server.url), { requestInit })
        : new StreamableHTTPClientTransport(new URL(server.url), { requestInit });
    }
    const client = new Client({ name: "slack-ai-agent", version: "2.0.0" });
    await client.connect(transport);
    this.connections.push({ client, transport });
    return { client, transport };
  }

  async close(): Promise<void> {
    const connections = this.connections.splice(0);
    await Promise.allSettled(connections.map(async ({ client, transport }) => {
      try { await client.close(); } catch { try { await transport.close?.(); } catch { /* fail closed */ } }
    }));
  }
}

function abortError(): Error { const error = new Error("Request aborted"); error.name = "AbortError"; return error; }
