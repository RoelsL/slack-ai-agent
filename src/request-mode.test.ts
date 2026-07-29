import { resolveMode } from "./request-mode";

describe("resolveMode", () => {
  it("returns empty mode for plain text and no channel override", () => {
    expect(resolveMode("hello", undefined)).toEqual({});
    expect(resolveMode(undefined, undefined)).toEqual({});
  });

  it("uses a configured deployment alias only", () => {
    expect(resolveMode("think hardest", { model: "fast-alias" })).toEqual({ model: "fast-alias" });
  });

  it("does not interpret fast/effort text or emoji as provider options", () => {
    expect(resolveMode("think fast :custom:", undefined, true, {})).toEqual({});
  });

  it("falls back to channel mode when no trigger is present", () => {
    expect(resolveMode("normal question", { model: "default-alias" })).toEqual({ model: "default-alias" });
  });

  it("lets message triggers override channel defaults", () => {
    expect(resolveMode("think fast", { model: "default-alias" })).toEqual({ model: "default-alias" });
  });

});
