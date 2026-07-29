import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileHandler, SLACK_UPLOAD_MAX_BYTES } from "./file-handler";

function response(body: Buffer): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
}

describe("FileHandler request-scoped uploads", () => {
  const app = { client: { files: { info: jest.fn() } } };
  const file = { id: "F1", name: "../unsafe name.txt", mimetype: "text/plain", size: 4 };

  afterEach(() => { jest.restoreAllMocks(); app.client.files.info.mockReset(); });

  it("formats logical identifiers and sanitizes the per-upload path", async () => {
    app.client.files.info.mockResolvedValue({ ok: true, file: { url_private_download: "https://slack.test/file" } });
    jest.spyOn(global, "fetch").mockResolvedValue(response(Buffer.from("data")));
    const handler = new FileHandler(app);
    const [processed] = await handler.downloadAndProcessFiles([file]);
    expect(processed.logicalId).toBe("upload:F1");
    expect(processed.path).not.toContain("unsafe name");
    expect(handler.formatFilesOnly([processed])).toContain("upload:F1");
    expect(handler.formatFilesOnly([processed])).not.toContain(processed.path);
    await handler.cleanupTempFiles([processed]);
    expect(fs.existsSync(processed.uploadDir)).toBe(false);
  });

  it("rejects declared and actual downloads above 50 MiB", async () => {
    const handler = new FileHandler(app);
    expect(await handler.downloadAndProcessFiles([{ ...file, size: SLACK_UPLOAD_MAX_BYTES + 1 }])).toEqual([]);
    app.client.files.info.mockResolvedValue({ ok: true, file: { url_private_download: "https://slack.test/file" } });
    jest.spyOn(global, "fetch").mockResolvedValue(response(Buffer.alloc(SLACK_UPLOAD_MAX_BYTES + 1)));
    expect(await handler.downloadAndProcessFiles([file])).toEqual([]);
  });
});
