import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LocalReadTool, LOCAL_READ_TOOL_NAME, LOCAL_READ_TIMEOUT_MS } from "./local-file-tool";
import { isSupportedToolName } from "./mcp-manager";
import type { AgentToolCall } from "./agent-types";

function call(value: unknown): AgentToolCall {
  return { id: "call-1", type: "function", function: { name: LOCAL_READ_TOOL_NAME, arguments: JSON.stringify(value) } };
}

describe("LocalReadTool", () => {
  let root: string;
  let manager: { authorizeTool: jest.Mock };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "local-read-test-"));
    manager = { authorizeTool: jest.fn().mockResolvedValue({ allowed: true, reason: "allowed" }) };
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  async function tool() {
    return (await LocalReadTool.create(manager as never, {
      user: "U1", channel: "C1", channelType: "im",
    }, root))!;
  }

  it("reads bounded UTF-8 workspace text and rechecks policy", async () => {
    fs.writeFileSync(path.join(root, "notes.txt"), "one\ntwo\nthree");
    const result = await (await tool()).dispatch(call({ path: "notes.txt", startLine: 2, endLine: 2 }));
    expect(result).toEqual({ text: "two" });
    expect(manager.authorizeTool).toHaveBeenCalledTimes(2);
  });

  it("uses only the stable MCP grammar and local read name", () => {
    expect(isSupportedToolName("mcp__github__read")).toBe(true);
    expect(isSupportedToolName("local__read")).toBe(true);
    for (const name of ["Bash", "Read", "Skill", "Task", "local__write", "unknown"]) {
      expect(isSupportedToolName(name)).toBe(false);
    }
  });

  it.each([null, [], {}, { path: "x", extra: true }, { path: 3 }, { path: "x", startLine: 201 }, { path: "x", startLine: 2, endLine: 1 }])("rejects malformed arguments %p", async value => {
    const result = await (await tool()).dispatch(call(value));
    expect(result.isError).toBe(true);
  });

  it.each(["../outside.txt", "/etc/passwd", ".env", "missing.txt"])("rejects unsafe or unavailable path %p", async value => {
    const result = await (await tool()).dispatch(call({ path: value }));
    expect(result.isError).toBe(true);
  });

  it("rejects symlink escape and binary content", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "local-read-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    try {
      expect((await (await tool()).dispatch(call({ path: "link.txt" }))).isError).toBe(true);
      expect((await (await tool()).dispatch(call({ path: "binary.bin" }))).isError).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects in-scope traversal, arbitrary temp paths, repository paths, and another workspace", async () => {
    fs.mkdirSync(path.join(root, "a"));
    fs.writeFileSync(path.join(root, "b.txt"), "safe");
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "other-session-"));
    fs.writeFileSync(path.join(other, "other.txt"), "other");
    try {
      for (const value of ["a/../b.txt", path.join(os.tmpdir(), "other.txt"), process.cwd(), path.join(other, "other.txt")]) {
        expect((await (await tool()).dispatch(call({ path: value }))).isError).toBe(true);
      }
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("reads an explicitly granted upload but not an ungranted identifier", async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-ai-upload-"));
    const uploadPath = path.join(uploadDir, "user-name.txt");
    fs.writeFileSync(uploadPath, "granted");
    try {
      const granted = (await LocalReadTool.create(manager as never, { user: "U1", channel: "C1", channelType: "im" }, root, [{ logicalId: "upload:file-1", displayName: "user-name.txt", realPath: uploadPath, size: 7 }]))!;
      expect(await granted.dispatch(call({ path: "upload:file-1" }))).toEqual({ text: "granted" });
      expect((await (await tool()).dispatch(call({ path: "upload:file-1" }))).isError).toBe(true);
    } finally {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }
  });

  it("rejects oversized files, line ranges, and aborts before filesystem access", async () => {
    fs.writeFileSync(path.join(root, "large.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, "a"));
    const local = await tool();
    expect((await local.dispatch(call({ path: "large.txt" }))).isError).toBe(true);
    expect((await local.dispatch(call({ path: "large.txt", endLine: 201 }))).isError).toBe(true);
    const controller = new AbortController();
    controller.abort();
    const realpath = jest.spyOn(fs.promises, "realpath");
    const lstat = jest.spyOn(fs.promises, "lstat");
    const readFile = jest.spyOn(fs.promises, "readFile");
    await expect(local.dispatch(call({ path: "large.txt" }), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(realpath).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    realpath.mockRestore(); lstat.mockRestore(); readFile.mockRestore();
  });

  it("rejects an oversized line independently of output truncation", async () => {
    fs.writeFileSync(path.join(root, "long-line.txt"), "x".repeat(16_001));
    expect((await (await tool()).dispatch(call({ path: "long-line.txt" }))).isError).toBe(true);
  });

  it("bounds returned text", async () => {
    fs.writeFileSync(path.join(root, "output.txt"), `${"a".repeat(8_000)}\n${"b".repeat(8_000)}\n${"c".repeat(8_000)}`);
    const result = await (await tool()).dispatch(call({ path: "output.txt" }));
    expect(result.text.length).toBeLessThanOrEqual(16_000 + "… [truncated]".length);
    expect(result.text).toContain("[truncated]");
  });

  it("denies before filesystem access when policy changes", async () => {
    const local = await tool();
    manager.authorizeTool.mockResolvedValue({ allowed: false, reason: "denylisted" });
    const result = await local.dispatch(call({ path: "anything.txt" }));
    expect(result).toEqual({ text: "Tool denied by policy", isError: true });
  });

  it("checks policy before any local filesystem operation", async () => {
    const local = await tool();
    const realpath = jest.spyOn(fs.promises, "realpath");
    const lstat = jest.spyOn(fs.promises, "lstat");
    const readFile = jest.spyOn(fs.promises, "readFile");
    manager.authorizeTool.mockResolvedValue({ allowed: false, reason: "denylisted" });
    await local.dispatch(call({ path: "notes.txt" }));
    expect(realpath).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    realpath.mockRestore(); lstat.mockRestore(); readFile.mockRestore();
  });

  it("propagates caller abort during read and passes the composed signal", async () => {
    fs.writeFileSync(path.join(root, "slow.txt"), "slow");
    const local = await tool();
    const controller = new AbortController();
    const readFile = jest.spyOn(fs.promises, "readFile").mockImplementation(async (_path, options) => {
      expect((options as { signal?: AbortSignal }).signal).toBeDefined();
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(local.dispatch(call({ path: "slow.txt" }), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    readFile.mockRestore();
  });

  it("returns a safe timeout result when the content read exceeds the bound", async () => {
    fs.writeFileSync(path.join(root, "slow.txt"), "slow");
    const local = await tool();
    jest.useFakeTimers();
    const readFile = jest.spyOn(fs.promises, "readFile").mockImplementation(async (_path, options) => {
      return await new Promise<never>((_resolve, reject) => setTimeout(() => {
        expect((options as { signal?: AbortSignal }).signal?.aborted).toBe(true);
        reject(Object.assign(new Error("timed out"), { name: "AbortError" }));
      }, LOCAL_READ_TIMEOUT_MS + 20));
    });
    const result = local.dispatch(call({ path: "slow.txt" }));
    await jest.advanceTimersByTimeAsync(LOCAL_READ_TIMEOUT_MS + 20);
    await expect(result).resolves.toEqual({ text: "Local read timed out", isError: true });
    readFile.mockRestore();
    jest.useRealTimers();
  });
});
