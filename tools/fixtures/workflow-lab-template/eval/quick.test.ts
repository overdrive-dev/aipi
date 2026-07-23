import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("empty-state copy acceptance", () => {
  it("uses the requested copy", () => {
    const source = fs.readFileSync(path.resolve("src/client/App.tsx"), "utf8");
    expect(source).toContain("No tasks match this view.");
    expect(source).not.toContain("No tasks yet.");
  });
});
