import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { McpManager } from "./mcp-manager";

describe("McpManager centralized policy gate", () => {
  let dir: string;
  let allowlist: string;
  let denylist: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-policy-"));
    allowlist = path.join(dir, "allow.yaml");
    denylist = path.join(dir, "deny.yaml");
    fs.writeFileSync(denylist, "disallowed_tools:\n  - mcp__github__blocked\n");
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("allows exact MCP tools, inherits roles, applies deny precedence, and rejects native names", async () => {
    fs.writeFileSync(allowlist, [
      "member:",
      "  - mcp__github__read",
      "engineer:",
      "  - mcp__github__blocked",
      "  - mcp__github__deploy",
    ].join("\n"));
    const manager = new McpManager(path.join(dir, "servers.json"), { allowlist, denylist });
    await expect(manager.authorizeTool("mcp__github__read", { role: "member", hasHumanIdentity: true }))
      .resolves.toMatchObject({ allowed: true });
    await expect(manager.authorizeTool("mcp__github__read", { role: "engineer", hasHumanIdentity: true }))
      .resolves.toMatchObject({ allowed: true });
    await expect(manager.authorizeTool("mcp__github__blocked", { role: "engineer", hasHumanIdentity: true }))
      .resolves.toMatchObject({ allowed: false, reason: "denylisted" });
    await expect(manager.authorizeTool("mcp__github__deploy", { role: "member", hasHumanIdentity: true }))
      .resolves.toMatchObject({ allowed: false, reason: "not-allowlisted" });
    for (const name of ["Bash", "Read", "Skill", "Task", "local__write"]) {
      await expect(manager.authorizeTool(name, { role: "engineer", hasHumanIdentity: true }))
        .resolves.toMatchObject({ allowed: false });
    }
  });

  it("denies a missing human identity before policy grants", async () => {
    fs.writeFileSync(allowlist, "member:\n  - mcp__github__read\n");
    const manager = new McpManager(path.join(dir, "servers.json"), { allowlist, denylist });
    await expect(manager.authorizeTool("mcp__github__read", { role: "member", hasHumanIdentity: false }))
      .resolves.toMatchObject({ allowed: false, reason: "anonymous" });
  });
});
