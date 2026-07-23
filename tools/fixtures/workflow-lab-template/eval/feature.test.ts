import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";

describe("priority filter acceptance", () => {
  it.each(["low", "medium", "high"])("filters API tasks by %s priority", async (priority) => {
    const response = await request(createApp()).get(`/api/tasks?priority=${priority}`);
    expect(response.status).toBe(200);
    expect(response.body.tasks).not.toHaveLength(0);
    expect(response.body.tasks.every((task: { priority: string }) => task.priority === priority)).toBe(true);
  });

  it("rejects an invalid priority instead of silently returning unrelated tasks", async () => {
    const response = await request(createApp()).get("/api/tasks?priority=urgent");
    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty("error");
  });
});
