import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTaskStatus, TaskStore } from "./store.js";

export function createApp(store = new TaskStore()) {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/api/tasks", (_request, response) => {
    response.json({ tasks: store.listTasks() });
  });

  app.patch("/api/tasks/:id/status", (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || !isTaskStatus(request.body?.status)) {
      response.status(400).json({ error: "invalid task status request" });
      return;
    }

    const task = store.updateStatus(id, request.body.status);
    if (!task) {
      response.status(404).json({ error: "task not found" });
      return;
    }
    response.json({ task });
  });

  const here = path.dirname(fileURLToPath(import.meta.url));
  const clientRoot = path.resolve(here, "..", "dist");
  app.use(express.static(clientRoot));
  app.use((_request, response) => response.sendFile(path.join(clientRoot, "index.html")));

  return app;
}
