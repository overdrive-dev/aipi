import fs from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";

describe("production readiness acceptance", () => {
  it("has a production client and server build", () => {
    expect(fs.existsSync("dist/index.html")).toBe(true);
    expect(fs.existsSync("dist-server/server.js")).toBe(true);
  });

  it("keeps the health check available", async () => {
    const response = await request(createApp()).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});
