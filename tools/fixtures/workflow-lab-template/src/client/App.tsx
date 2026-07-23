import { useEffect, useState } from "react";

type Priority = "low" | "medium" | "high";
type TaskStatus = "todo" | "in_progress" | "completed";

interface Task {
  id: number;
  title: string;
  priority: Priority;
  status: TaskStatus;
  completionEvents: number;
}

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/tasks")
      .then((response) => response.json())
      .then((payload: { tasks: Task[] }) => setTasks(payload.tasks))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main>
      <p className="eyebrow">Local workflow dogfood</p>
      <h1>Taskboard</h1>
      <p className="lede">A small real application for exercising changes across an API and a browser UI.</p>

      <section aria-labelledby="tasks-heading">
        <div className="section-heading">
          <h2 id="tasks-heading">Tasks</h2>
          <span>{tasks.length} total</span>
        </div>
        {loading ? <p>Loading tasks...</p> : null}
        {!loading && tasks.length === 0 ? <p>No tasks yet.</p> : null}
        <ul>
          {tasks.map((task) => (
            <li key={task.id}>
              <div>
                <strong>{task.title}</strong>
                <small>{task.status.replace("_", " ")}</small>
              </div>
              <span className={`priority priority-${task.priority}`}>{task.priority}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
