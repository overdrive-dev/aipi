import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { TaskStore } from "./store.js";

describe("taskboard API", () => {
  it("reports a healthy process", async () => {
    const response = await request(createApp()).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("lists the seeded tasks", async () => {
    const response = await request(createApp()).get("/api/tasks");
    expect(response.status).toBe(200);
    expect(response.body.tasks).toHaveLength(3);
  });

  it("records the first completion event", async () => {
    const app = createApp(new TaskStore());
    const response = await request(app).patch("/api/tasks/1/status").send({ status: "completed" });
    expect(response.status).toBe(200);
    expect(response.body.task).toMatchObject({ status: "completed", completionEvents: 1 });
  });
});
