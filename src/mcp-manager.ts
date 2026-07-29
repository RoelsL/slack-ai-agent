import * as fs from "fs";
import * as path from "path";
import { Logger } from "./logger";
import { CONTEXT_CACHE_TTL_MS } from "./constants";
import * as yaml from "js-yaml";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
export const MCP_HEADERS_HELPER_TIMEOUT_MS = 5_000;
export const MCP_HEADERS_HELPER_MAX_STDOUT = 32 * 1024;
export const MCP_HEADERS_HELPER_MAX_STDERR = 16 * 1024;

/**
 * Tool allowlist loaded from config/tool-allowlist.yaml.
 * Keys are role names listed in order of increasing privilege.
 * Each role inherits all tools from roles listed before it.
 * Adding a new role requires only a YAML change — no TypeScript updates.
 */
type ToolAllowlist = Record<string, string[]>;

interface ToolDenylist {
  disallowed_tools: string[];
}

export interface ToolPolicyDecision {
  allowed: boolean;
  reason: "allowed" | "not-allowlisted" | "denylisted" | "invalid-policy" | "anonymous";
}

export interface ToolPolicyContext {
  role?: string;
  hasHumanIdentity: boolean;
}

export type McpStdioServerConfig = {
  type?: "stdio"; // Optional for backwards compatibility
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpSSEServerConfig = {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  /**
   * Deferred Session 2 header helper command; its stdout (a JSON
   * object) is merged over `headers`. Lets short-lived credentials (e.g. a
   * service-account token a cron job refreshes on disk) stay fresh without
   * regenerating mcp-servers.json.
   */
  headersHelper?: string;
  /** See {@link bindUserToMcpServers}. Not passed through to the SDK. */
  userEmailHeader?: string;
};

export type McpHttpServerConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  /** See {@link McpSSEServerConfig.headersHelper}. */
  headersHelper?: string;
  /** See {@link bindUserToMcpServers}. Not passed through to the SDK. */
  userEmailHeader?: string;
};

export type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig;

export interface McpConfiguration {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Bind the requesting user's identity to identity-aware MCP servers.
 *
 * A server config may declare `userEmailHeader` (e.g. "X-User-Email"). Such a
 * server wants to know, per request, which human is asking — so it can pin
 * lookups to the requester instead of trusting a model-supplied argument.
 *
 * For each server declaring `userEmailHeader`:
 *   - with a resolved email: a copy of the config is returned with the email
 *     injected under that header (and the marker field stripped, since the
 *     SDK doesn't know it);
 *   - without one (bot/workflow-triggered request, or the user isn't in the
 *     employee directory): the server is OMITTED for this request. Fail
 *     closed — an identity-bound server must never receive an anonymous
 *     session the model could steer toward an arbitrary subject.
 *
 * Servers that don't declare `userEmailHeader` pass through unchanged. Input
 * configs are never mutated (they're shared across requests via McpManager's
 * cache).
 */
export function bindUserToMcpServers(
  servers: Record<string, McpServerConfig>,
  userEmail: string | undefined,
): { servers: Record<string, McpServerConfig>; omitted: string[] } {
  const bound: Record<string, McpServerConfig> = {};
  const omitted: string[] = [];

  for (const [name, config] of Object.entries(servers)) {
    const headerName =
      (config.type === "sse" || config.type === "http") &&
      typeof config.userEmailHeader === "string"
        ? config.userEmailHeader.trim()
        : "";

    if (!headerName) {
      bound[name] = config;
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userEmailHeader, ...sdkConfig } = config as
      | McpSSEServerConfig
      | McpHttpServerConfig;

    if (!userEmail) {
      omitted.push(name);
      continue;
    }

    bound[name] = {
      ...sdkConfig,
      headers: { ...sdkConfig.headers, [headerName]: userEmail },
    };
  }

  return { servers: bound, omitted };
}

/** Execute a deployment-owned helper and return only a validated string map. */
export async function resolveMcpHeaders(
  helper: string | undefined,
  staticHeaders: Record<string, string> | undefined,
): Promise<Record<string, string>> {
  const headers = { ...(staticHeaders ?? {}) };
  if (!helper?.trim()) return headers;
  try {
    const result = await execFileAsync("/bin/sh", ["-c", helper], {
      timeout: MCP_HEADERS_HELPER_TIMEOUT_MS,
      maxBuffer: Math.max(MCP_HEADERS_HELPER_MAX_STDOUT, MCP_HEADERS_HELPER_MAX_STDERR),
      windowsHide: true,
    });
    const parsed: unknown = JSON.parse(String(result.stdout));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("helper output is not an object");
    for (const [key, value] of Object.entries(parsed)) {
      if (!key || typeof value !== "string") throw new Error("helper headers must be strings");
      headers[key] = value;
    }
    return headers;
  } catch {
    // Never connect without credentials when a configured helper fails.
    throw new Error("MCP header helper failed");
  }
}

export class McpManager {
  private logger = new Logger("McpManager");
  private config: McpConfiguration | null = null;
  private configPath: string;
  private allowlistCache: { data: ToolAllowlist; fetchedAt: number } | null =
    null;
  private denylistCache: {
    data: string[];
    fetchedAt: number;
    isError: boolean;
  } | null = null;
  private readonly CACHE_TTL_MS = CONTEXT_CACHE_TTL_MS;

  constructor(configPath: string = "./mcp-servers.json") {
    this.configPath = path.resolve(configPath);
  }

  loadConfiguration(): McpConfiguration | null {
    if (this.config) {
      return this.config;
    }

    try {
      if (!fs.existsSync(this.configPath)) {
        this.logger.info("No MCP configuration file found", {
          path: this.configPath,
        });
        return null;
      }

      const configContent = fs.readFileSync(this.configPath, "utf-8");
      const parsedConfig = JSON.parse(configContent);

      if (
        !parsedConfig.mcpServers ||
        typeof parsedConfig.mcpServers !== "object"
      ) {
        this.logger.warn(
          "Invalid MCP configuration: missing or invalid mcpServers",
          { path: this.configPath },
        );
        return null;
      }

      // Validate server configurations
      for (const [serverName, serverConfig] of Object.entries(
        parsedConfig.mcpServers,
      )) {
        if (
          !this.validateServerConfig(
            serverName,
            serverConfig as McpServerConfig,
          )
        ) {
          this.logger.warn("Invalid server configuration, skipping", {
            serverName,
          });
          delete parsedConfig.mcpServers[serverName];
        }
      }

      this.config = parsedConfig as McpConfiguration;

      this.logger.info("Loaded MCP configuration", {
        path: this.configPath,
        serverCount: Object.keys(this.config.mcpServers).length,
        servers: Object.keys(this.config.mcpServers),
      });

      return this.config;
    } catch (error) {
      this.logger.error("Failed to load MCP configuration", error);
      return null;
    }
  }

  private validateServerConfig(
    serverName: string,
    config: McpServerConfig,
  ): boolean {
    if (!config || typeof config !== "object") {
      return false;
    }

    // Validate based on type
    if (!config.type || config.type === "stdio") {
      // Stdio server
      const stdioConfig = config as McpStdioServerConfig;
      if (!stdioConfig.command || typeof stdioConfig.command !== "string") {
        this.logger.warn("Stdio server missing command", { serverName });
        return false;
      }
    } else if (config.type === "sse" || config.type === "http") {
      // SSE or HTTP server
      const urlConfig = config as McpSSEServerConfig | McpHttpServerConfig;
      if (!urlConfig.url || typeof urlConfig.url !== "string") {
        this.logger.warn("SSE/HTTP server missing URL", {
          serverName,
          type: config.type,
        });
        return false;
      }
    } else {
      this.logger.warn("Unknown server type", {
        serverName,
        type: config.type,
      });
      return false;
    }

    return true;
  }

  getServerConfiguration(): Record<string, McpServerConfig> | undefined {
    const config = this.loadConfiguration();
    return config?.mcpServers;
  }

  bindForRequest(
    servers: Record<string, McpServerConfig>,
    userEmail: string | undefined,
  ): Record<string, McpServerConfig> {
    return bindUserToMcpServers(servers, userEmail).servers;
  }

  /**
   * Load tool allowlist from local config file with caching
   */
  private async loadToolAllowlist(): Promise<ToolAllowlist> {
    const now = Date.now();

    if (
      this.allowlistCache &&
      now - this.allowlistCache.fetchedAt < this.CACHE_TTL_MS
    ) {
      return this.allowlistCache.data;
    }

    const allowlistContent = fs.readFileSync(
      path.resolve("config/tool-allowlist.yaml"),
      "utf-8",
    );
    const allowlist = yaml.load(allowlistContent) as ToolAllowlist;

    this.allowlistCache = { data: allowlist, fetchedAt: now };
    this.logger.debug("Loaded tool allowlist from local file");
    return allowlist;
  }

  /**
   * Get the highest (most privileged) role from the tool allowlist.
   * Returns undefined if no allowlist is configured.
   */
  async getHighestRole(): Promise<string | undefined> {
    const allowlist = await this.loadToolAllowlist();
    const hierarchy = Object.keys(allowlist);
    return hierarchy.length > 0 ? hierarchy[hierarchy.length - 1] : undefined;
  }

  /**
   * Get allowed tools for a user based on their role.
   * The role hierarchy is derived from the key order in tool-allowlist.yaml.
   * Tools accumulate: each role inherits all tools from roles listed before it.
   * Returns an empty array for "none" or unrecognized roles.
   */
  async getAllowedTools(role: string): Promise<string[]> {
    if (role === "none") {
      return [];
    }

    const allowlist = await this.loadToolAllowlist();
    const hierarchy = Object.keys(allowlist);
    if (hierarchy.length === 0) {
      return [];
    }

    const roleIndex = hierarchy.indexOf(role);
    if (roleIndex === -1) {
      this.logger.warn("Unknown role in tool allowlist, granting no tools", {
        role,
        available: hierarchy,
      });
      return [];
    }

    const tools: string[] = [];
    for (let i = 0; i <= roleIndex; i++) {
      const tierTools = allowlist[hierarchy[i]];
      if (tierTools) {
        tools.push(...tierTools);
      }
    }

    return tools;
  }

  /** The single authorization gate used for advertisement and dispatch. */
  async authorizeTool(name: string, context: ToolPolicyContext): Promise<ToolPolicyDecision> {
    if (!/^mcp__[A-Za-z0-9._-]+__[A-Za-z0-9._-]+$/.test(name)) {
      return { allowed: false, reason: "not-allowlisted" };
    }
    if (!context.hasHumanIdentity) return { allowed: false, reason: "anonymous" };
    try {
      const allowed = await this.getAllowedTools(context.role ?? "none");
      const denylisted = this.getDisallowedTools();
      if (this.denylistCache?.isError) {
        return { allowed: false, reason: "invalid-policy" };
      }
      if (denylisted.some(pattern => this.matchesTool(pattern, name))) {
        return { allowed: false, reason: "denylisted" };
      }
      if (!allowed.some(pattern => this.matchesTool(pattern, name))) {
        return { allowed: false, reason: "not-allowlisted" };
      }
      return { allowed: true, reason: "allowed" };
    } catch {
      return { allowed: false, reason: "invalid-policy" };
    }
  }

  private matchesTool(pattern: unknown, name: string): boolean {
    // Legacy native names and Bash(...) entries intentionally never match.
    return typeof pattern === "string" && /^mcp__[A-Za-z0-9._-]+__[A-Za-z0-9._-]+$/.test(pattern) && pattern === name;
  }

  // Retry loading denylist every 30s on error so fixes are picked up quickly
  private static readonly DENYLIST_ERROR_CACHE_TTL_MS = 30 * 1000;

  /**
   * Load tool denylist from local config file with caching.
   * Successful loads are cached for CACHE_TTL_MS (1 hour).
   * Errors are cached for DENYLIST_ERROR_CACHE_TTL_MS (30s) so fixes self-heal.
   */
  private loadToolDenylist(): string[] {
    const now = Date.now();

    if (this.denylistCache) {
      const ttl = this.denylistCache.isError
        ? McpManager.DENYLIST_ERROR_CACHE_TTL_MS
        : this.CACHE_TTL_MS;
      if (now - this.denylistCache.fetchedAt < ttl) {
        return this.denylistCache.data;
      }
    }

    const denylistPath = path.resolve("config/tool-denylist.yaml");
    if (!fs.existsSync(denylistPath)) {
      this.logger.warn("No tool denylist file found — denying all tools");
      this.denylistCache = { data: [], fetchedAt: now, isError: true };
      return [];
    }

    let denylist: ToolDenylist;
    try {
      const denylistContent = fs.readFileSync(denylistPath, "utf-8");
      denylist = yaml.load(denylistContent) as ToolDenylist;
    } catch (error) {
      this.logger.warn("Failed to read/parse tool denylist file — denying all tools", error);
      this.denylistCache = { data: [], fetchedAt: now, isError: true };
      return [];
    }

    if (
      !denylist?.disallowed_tools ||
      !Array.isArray(denylist.disallowed_tools) ||
      denylist.disallowed_tools.length === 0
    ) {
      this.logger.warn("Tool denylist file exists but has no valid disallowed_tools entries");
      this.denylistCache = { data: [], fetchedAt: now, isError: true };
      return [];
    }

    const tools = denylist.disallowed_tools;
    this.denylistCache = { data: tools, fetchedAt: now, isError: false };
    this.logger.debug("Loaded tool denylist from local file");
    return tools;
  }

  /**
   * Get disallowed tools from the denylist config
   */
  getDisallowedTools(): string[] {
    return this.loadToolDenylist();
  }
}
