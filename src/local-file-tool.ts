import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import { AgentToolCall, FunctionToolDefinition, UploadGrant } from "./agent-types";
import { McpManager, ToolPolicyContext } from "./mcp-manager";
import { SlackContext } from "./types";
import { DiscoveredTool, TOOL_RESULT_MAX_SIZE } from "./mcp-client";
import { UserUtils } from "./user-utils";

export const LOCAL_READ_TOOL_NAME = "local__read";
export const LOCAL_READ_MAX_PATH_LENGTH = 1_024;
export const LOCAL_READ_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const LOCAL_READ_MAX_LINES = 200;
export const LOCAL_READ_MAX_LINE_LENGTH = 16_000;
/** Maximum wall-clock time for one local read dispatch, including resolution. */
export const LOCAL_READ_TIMEOUT_MS = 5_000;

const LOCAL_READ_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1, maxLength: LOCAL_READ_MAX_PATH_LENGTH },
    startLine: { type: "integer", minimum: 1, maximum: LOCAL_READ_MAX_LINES },
    endLine: { type: "integer", minimum: 1, maximum: LOCAL_READ_MAX_LINES },
  },
  required: ["path"],
  additionalProperties: false,
};

export interface LocalReadInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface LocalReadScope {
  workspace: string;
  uploads: UploadGrant[];
}

/** Read-only, request-scoped filesystem capability. There is deliberately no
 * generic path access method: every read is resolved through this class. */
export class LocalReadTool {
  private constructor(
    private readonly manager: McpManager,
    private readonly policyContext: ToolPolicyContext,
    private readonly scope: LocalReadScope,
  ) {}

  static async create(
    manager: McpManager,
    context: SlackContext,
    workspace: string,
    uploads: UploadGrant[] = [],
  ): Promise<DiscoveredTool | undefined> {
    const human = !context.botId && !context.workflowId && context.user !== "USLACKBOT";
    const role = human ? await UserUtils.getUserRole(context.user) : "none";
    const email = human ? await UserUtils.getUserEmail(context.user) : undefined;
    const policyContext = { role, hasHumanIdentity: human && !!email };
    const decision = await manager.authorizeTool(LOCAL_READ_TOOL_NAME, policyContext);
    if (!decision.allowed) return undefined;

    const capability = new LocalReadTool(manager, policyContext, { workspace, uploads });
    return {
      definition: {
        type: "function",
        function: {
          name: LOCAL_READ_TOOL_NAME,
          description: "Read bounded UTF-8 text from the current request workspace or an explicitly uploaded file.",
          parameters: LOCAL_READ_SCHEMA,
        },
      },
      dispatch: (call, signal) => capability.dispatch(call, signal),
    };
  }

  private async dispatch(call: AgentToolCall, signal?: AbortSignal): Promise<{ text: string; isError?: boolean }> {
    const latest = await this.manager.authorizeTool(LOCAL_READ_TOOL_NAME, this.policyContext);
    if (!latest.allowed) return { text: "Tool denied by policy", isError: true };
    if (signal?.aborted) throw abortError();

    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutController.abort(), LOCAL_READ_TIMEOUT_MS);
    const timeoutSignal = timeoutController.signal;
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const checkCancellation = () => {
      if (signal?.aborted) throw abortError();
      return !timeoutSignal.aborted;
    };

    try {
      let input: unknown;
      try {
        input = JSON.parse(call.function.arguments);
      } catch {
        return { text: "Invalid JSON tool arguments", isError: true };
      }
      const validated = validateInput(input);
      if (!validated) return { text: "Invalid local read arguments", isError: true };
      if (!checkCancellation()) return timeoutResult();
      const target = await this.resolveTarget(validated.path);
      if (!checkCancellation()) return timeoutResult();
      if (!target) return { text: "File is outside the permitted request scope", isError: true };
      if (!checkCancellation()) return timeoutResult();

      try {
        const stat = await fs.lstat(target);
        if (!checkCancellation()) return timeoutResult();
        if (!stat.isFile() || stat.size > LOCAL_READ_MAX_FILE_BYTES) {
          return { text: "File is unavailable or exceeds the local read limit", isError: true };
        }
        const content = await fs.readFile(target, { encoding: "utf8", signal: combinedSignal });
        if (!checkCancellation()) return timeoutResult();
        if (content.includes("\0")) return { text: "Binary files are not supported", isError: true };
        const lines = content.split(/\r?\n/);
        const start = validated.startLine ?? 1;
        const end = validated.endLine ?? Math.min(lines.length, start + LOCAL_READ_MAX_LINES - 1);
        if (end < start || end - start + 1 > LOCAL_READ_MAX_LINES) {
          return { text: "Requested line range exceeds the local read limit", isError: true };
        }
        const selected = lines.slice(start - 1, end);
        if (selected.some(line => line.length > LOCAL_READ_MAX_LINE_LENGTH)) {
          return { text: "File contains a line that exceeds the local read limit", isError: true };
        }
        const text = selected.join("\n");
        return { text: text.length > TOOL_RESULT_MAX_SIZE ? `${text.slice(0, TOOL_RESULT_MAX_SIZE)}… [truncated]` : text };
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (timeoutSignal.aborted) return timeoutResult();
        return { text: "File is unavailable or outside the permitted request scope", isError: true };
      }
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (timeoutSignal.aborted) return timeoutResult();
      throw error;
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  private async resolveTarget(logicalPath: string): Promise<string | undefined> {
    const upload = this.scope.uploads.find(grant => grant.logicalId === logicalPath);
    const root = upload ? path.dirname(upload.realPath) : this.scope.workspace;
    const relative = upload ? path.basename(upload.realPath) : logicalPath;
    if (!upload && (path.isAbsolute(relative) || relative.includes("\0") || hasTraversalComponent(relative) || hasSensitiveSegment(relative))) return undefined;
    if (upload && (hasSensitiveSegment(upload.displayName) || !isSafeUploadPath(upload.realPath))) return undefined;

    const rootReal = await fs.realpath(root).catch(() => undefined);
    if (!rootReal) return undefined;
    const candidate = path.resolve(rootReal, relative);
    const candidateReal = await fs.realpath(candidate).catch(() => undefined);
    if (!candidateReal || !isContained(rootReal, candidateReal)) return undefined;
    if (isRepoPath(candidateReal) || hasSensitiveSegment(path.relative(rootReal, candidateReal))) return undefined;

    // Reject symlinks even when they happen to resolve inside the capability.
    const parts = path.relative(rootReal, candidateReal).split(path.sep).filter(Boolean);
    let current = rootReal;
    for (const part of parts) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch(() => undefined);
      if (!stat || stat.isSymbolicLink()) return undefined;
    }
    return candidateReal;
  }
}

function validateInput(value: unknown): LocalReadInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["path", "startLine", "endLine"].includes(key))) return undefined;
  if (typeof input.path !== "string" || input.path.length < 1 || input.path.length > LOCAL_READ_MAX_PATH_LENGTH) return undefined;
  for (const key of ["startLine", "endLine"] as const) {
    if (input[key] !== undefined && (!Number.isInteger(input[key]) || Number(input[key]) < 1 || Number(input[key]) > LOCAL_READ_MAX_LINES)) return undefined;
  }
  if (input.startLine !== undefined && input.endLine !== undefined && Number(input.endLine) < Number(input.startLine)) return undefined;
  return { path: input.path, ...(typeof input.startLine === "number" && { startLine: input.startLine }), ...(typeof input.endLine === "number" && { endLine: input.endLine }) };
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function hasSensitiveSegment(value: string): boolean {
  return value.split(/[\\/]+/).some(segment => /^(?:\.env(?:\..*)?|.*(?:secret|credential|token|api[-_]?key).*)$/i.test(segment));
}

function isSafeUploadPath(value: string): boolean {
  if (!value.startsWith(os.tmpdir() + path.sep)) return false;
  const uploadDir = path.dirname(value);
  return path.basename(uploadDir).startsWith("slack-ai-upload-");
}

function hasTraversalComponent(value: string): boolean {
  return value.split(/[\\/]+/).some(component => component === "..");
}

function isRepoPath(value: string): boolean {
  const repo = fsSync.realpathSync(process.cwd());
  return isContained(repo, value);
}

function timeoutResult(): { text: string; isError: true } {
  return { text: "Local read timed out", isError: true };
}

function abortError(): Error { const error = new Error("Request aborted"); error.name = "AbortError"; return error; }
