import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { TaskStore } from "../src/server/store.js";

describe("completion idempotency acceptance", () => {
  it("does not record a second completion event for the same state", async () => {
    const app = createApp(new TaskStore());
    const first = await request(app).patch("/api/tasks/1/status").send({ status: "completed" });
    const repeated = await request(app).patch("/api/tasks/1/status").send({ status: "completed" });

    expect(first.status).toBe(200);
    expect(first.body.task.completionEvents).toBe(1);
    expect(repeated.status).toBe(200);
    expect(repeated.body.task.completionEvents).toBe(1);
  });
});
