export type Priority = "low" | "medium" | "high";
export type TaskStatus = "todo" | "in_progress" | "completed";

export interface Task {
  id: number;
  title: string;
  priority: Priority;
  status: TaskStatus;
  completionEvents: number;
}

const seedTasks: Task[] = [
  { id: 1, title: "Review launch checklist", priority: "high", status: "todo", completionEvents: 0 },
  { id: 2, title: "Polish empty state", priority: "medium", status: "in_progress", completionEvents: 0 },
  { id: 3, title: "Archive old notes", priority: "low", status: "completed", completionEvents: 1 },
];

export class TaskStore {
  private tasks: Task[];

  constructor(tasks: Task[] = seedTasks) {
    this.tasks = structuredClone(tasks);
  }

  listTasks(): Task[] {
    return structuredClone(this.tasks);
  }

  updateStatus(id: number, status: TaskStatus): Task | null {
    const task = this.tasks.find((candidate) => candidate.id === id);
    if (!task) return null;

    task.status = status;
    if (status === "completed") task.completionEvents += 1;
    return structuredClone(task);
  }
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "todo" || value === "in_progress" || value === "completed";
}
