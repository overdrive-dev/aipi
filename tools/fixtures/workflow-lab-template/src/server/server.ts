import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 4174);
createApp().listen(port, "127.0.0.1", () => {
  console.log(`Taskboard listening on http://127.0.0.1:${port}`);
});
