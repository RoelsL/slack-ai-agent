import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { McpRequestToolSet } from "./mcp-client";
import { McpManager } from "./mcp-manager";
import { UserUtils } from "./user-utils";
import type { SlackContext } from "./types";

describe("Gitora MCP interoperability through the installed SDK", () => {
  let directory: string;
  let server: http.Server;
  let endpoint: string;
  let authMode: "valid" | "invalid" | "expired" = "valid";
  let protocolVersion = "2025-03-26";
  let requests: Array<{ body: Record<string, unknown>; authorization?: string; url?: string }> = [];

  const context: SlackContext = {
    user: "U123",
    channel: "C123",
    channelType: "im",
  };

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "gitora-mcp-client-"));
    authMode = "valid";
    protocolVersion = "2025-03-26";
    requests = [];

    server = http.createServer((request, response) => {
      const authorization = request.headers.authorization;
      if (authorization !== "Bearer test-token" || authMode === "invalid" || authMode === "expired") {
        response.writeHead(401, { "WWW-Authenticate": 'Bearer realm="gitora-mcp"' });
        response.end();
        return;
      }
      if (request.method === "GET") {
        response.writeHead(405);
        response.end();
        return;
      }

      let raw = "";
      request.on("data", chunk => { raw += chunk; });
      request.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        requests.push({ body, authorization, url: request.url });
        const id = body.id;
        const method = body.method;
        response.setHeader("Content-Type", "application/json");
        if (method === "initialize") {
          response.setHeader("Mcp-Session-Id", "test-session");
          response.end(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "gitora-test", version: "test" },
            },
          }));
          return;
        }
        if (method === "notifications/initialized") {
          response.writeHead(202);
          response.end();
          return;
        }
        if (method === "tools/list") {
          response.end(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [
                { name: "list_projects", description: "List projects", inputSchema: { type: "object", additionalProperties: false } },
                { name: "search_projects", description: "Search projects", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } }, additionalProperties: false } },
                 { name: "get_project", description: "Get a project", inputSchema: { type: "object", required: ["projectId"], properties: { projectId: { type: "integer" } }, additionalProperties: false } },
                 { name: "list_project_packages", description: "List project packages", inputSchema: { type: "object", required: ["projectId"], properties: { projectId: { type: "integer" }, limit: { type: "integer", minimum: 1, maximum: 25 }, cursor: { type: "string" } }, additionalProperties: false } },
                 { name: "get_project_package", description: "Get exact project package", inputSchema: { type: "object", required: ["projectId", "machineName"], properties: { projectId: { type: "integer", minimum: 1 }, machineName: { type: "string", minLength: 1, maxLength: 200 } }, additionalProperties: false } },
                { name: "create_project", description: "Must never be exposed", inputSchema: { type: "object" } },
              ],
            },
          }));
          return;
        }
        if (method === "tools/call") {
          const params = body.params as { name?: string; arguments?: Record<string, unknown> };
          const name = params.name;
          const args = params.arguments ?? {};
           if (name === "get_project" && args.projectId === 999) {
            response.end(JSON.stringify({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "Project not found" }] } }));
            return;
           }
            if (name === "list_project_packages") {
              response.end(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ packages: [{ release: { version: "1.2.3" } }], nextCursor: null, moreResultsAvailable: false }) }] } }));
              return;
            }
            if (name === "get_project_package") {
              response.end(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ package: { package: { machineName: "drupal/core" }, release: { version: "10.3.1" } } }) }] } }));
              return;
            }
          response.end(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ projects: [{ id: 1, name: "Gitora" }] }) }] } }));
          return;
        }
        response.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    endpoint = `http://127.0.0.1:${address.port}/mcp`;
    jest.spyOn(UserUtils, "getUserEmail").mockResolvedValue("person@example.com");
    jest.spyOn(UserUtils, "getUserRole").mockResolvedValue("member");
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function writeConfiguration(options: { enabled?: boolean; helper?: string; includeOther?: boolean } = {}): McpManager {
    const allowlist = path.join(directory, "allow.yaml");
    const denylist = path.join(directory, "deny.yaml");
    fs.writeFileSync(allowlist, [
      "member:",
      "  - mcp__gitora__list_projects",
      "  - mcp__gitora__search_projects",
      "  - mcp__gitora__get_project",
      "  - mcp__gitora__list_project_packages",
      "  - mcp__gitora__get_project_package",
      ...(options.includeOther ? ["  - mcp__other__list_projects"] : []),
    ].join("\n") + "\n");
    fs.writeFileSync(denylist, "disallowed_tools:\n  - mcp__gitora__create_project\n");
    const configPath = path.join(directory, "mcp-servers.json");
    const gitora = {
        enabled: options.enabled ?? true,
        type: "http",
        url: endpoint,
        headersHelper: options.helper ?? "printf '%s' '{\"Authorization\":\"Bearer test-token\"}'",
        requireHeadersHelper: true,
        allowedHeaders: ["Authorization"],
        requiredHeaders: ["Authorization"],
         allowedTools: ["list_projects", "search_projects", "get_project", "list_project_packages", "get_project_package"],
    };
    const mcpServers: Record<string, unknown> = { gitora };
    if (options.includeOther) {
      mcpServers.other = {
        type: "http",
        url: `${endpoint}?server=other`,
        headersHelper: "printf '%s' '{\"Authorization\":\"Bearer test-token\"}'",
      };
    }
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers }));
    return new McpManager(configPath, { allowlist, denylist });
  }

  it("authenticates initialize, negotiates 2025-03-26, lists only the four tools, and calls project tools", async () => {
    const toolSet = await McpRequestToolSet.create(writeConfiguration(), context);
    expect(toolSet.tools.map(tool => tool.definition.function.name)).toEqual([
      "mcp__gitora__list_projects",
      "mcp__gitora__search_projects",
      "mcp__gitora__get_project",
      "mcp__gitora__list_project_packages",
      "mcp__gitora__get_project_package",
    ]);
    expect(requests[0].body.method).toBe("initialize");
    expect((requests[0].body.params as Record<string, unknown>).protocolVersion).toBe("2025-03-26");
    expect(requests.every(request => request.authorization === "Bearer test-token")).toBe(true);
    const result = await toolSet.tools[0].dispatch({ id: "call-1", type: "function", function: { name: "mcp__gitora__list_projects", arguments: "{}" } });
    expect(result).toMatchObject({ text: JSON.stringify({ projects: [{ id: 1, name: "Gitora" }] }), isError: false });
    const packages = toolSet.tools.find(tool => tool.definition.function.name.endsWith("list_project_packages"))!;
    const packageResult = await packages.dispatch({ id: "call-packages", type: "function", function: { name: packages.definition.function.name, arguments: JSON.stringify({ projectId: 1, limit: 1 }) } });
    expect(packageResult).toMatchObject({ text: JSON.stringify({ packages: [{ release: { version: "1.2.3" } }], nextCursor: null, moreResultsAvailable: false }), isError: false });
    const direct = toolSet.tools.find(tool => tool.definition.function.name.endsWith("get_project_package"))!;
    const directResult = await direct.dispatch({ id: "call-direct", type: "function", function: { name: direct.definition.function.name, arguments: JSON.stringify({ projectId: 1, machineName: "drupal/core" }) } });
    expect(directResult).toMatchObject({ text: JSON.stringify({ package: { package: { machineName: "drupal/core" }, release: { version: "10.3.1" } } }), isError: false });
    await toolSet.close();
  });

  it("does not pin a non-Gitora HTTP server to Gitora's protocol version", async () => {
    const toolSet = await McpRequestToolSet.create(writeConfiguration({ includeOther: true }), context);
    const otherInitialize = requests.find(request => request.url?.includes("server=other") && request.body.method === "initialize");
    expect(otherInitialize).toBeDefined();
    expect((otherInitialize!.body.params as Record<string, unknown>).protocolVersion).not.toBe("2025-03-26");
    await toolSet.close();
  });

  it("rejects invalid arguments locally and preserves a bounded missing-project error", async () => {
    const toolSet = await McpRequestToolSet.create(writeConfiguration(), context);
    const search = toolSet.tools.find(tool => tool.definition.function.name.endsWith("search_projects"))!;
    await expect(search.dispatch({ id: "call-2", type: "function", function: { name: search.definition.function.name, arguments: "{}" } }))
      .resolves.toEqual({ text: "Tool arguments failed schema validation", isError: true });
    const list = toolSet.tools.find(tool => tool.definition.function.name.endsWith("list_projects"))!;
    await expect(list.dispatch({ id: "call-2b", type: "function", function: { name: list.definition.function.name, arguments: JSON.stringify({ limit: 51 }) } }))
      .resolves.toEqual({ text: "Tool arguments failed schema validation", isError: true });
    const detail = toolSet.tools.find(tool => tool.definition.function.name.endsWith("get_project"))!;
    await expect(detail.dispatch({ id: "call-3", type: "function", function: { name: detail.definition.function.name, arguments: JSON.stringify({ projectId: 999 }) } }))
      .resolves.toEqual({ text: "Project not found", isError: true });
    await toolSet.close();
  });

  it.each([
    ["disabled", { enabled: false }, false],
    ["incomplete credential configuration", { helper: "" }, false],
  ])("does not connect when Gitora is %s", async (_label, options, expected) => {
    const toolSet = await McpRequestToolSet.create(writeConfiguration(options), context);
    expect(toolSet.tools.length > 0).toBe(expected);
    expect(requests).toHaveLength(0);
    await toolSet.close();
  });

  it.each(["invalid", "expired"] as const)("fails closed when the service credential is %s", async mode => {
    authMode = mode;
    const toolSet = await McpRequestToolSet.create(writeConfiguration(), context);
    expect(toolSet.tools).toHaveLength(0);
    await toolSet.close();
  });

  it("does not dispatch a newly advertised Gitora tool after discovery", async () => {
    const toolSet = await McpRequestToolSet.create(writeConfiguration(), context);
    expect(toolSet.tools.some(tool => tool.definition.function.name.endsWith("create_project"))).toBe(false);
    await toolSet.close();
  });

  it("fails closed when the server negotiates an unsupported protocol version", async () => {
    protocolVersion = "2024-01-01";
    const toolSet = await McpRequestToolSet.create(writeConfiguration(), context);
    expect(toolSet.tools).toHaveLength(0);
    await toolSet.close();
  });
});
