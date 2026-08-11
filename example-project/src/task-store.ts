export interface Task {
  id: string;
  title: string;
  completed: boolean;
}

export class TaskStore {
  private readonly tasks = new Map<string, Task>();

  add(id: string, title: string): Task {
    if (!id.trim()) throw new Error('任务 ID 不能为空');
    if (!title.trim()) throw new Error('任务标题不能为空');
    if (this.tasks.has(id)) throw new Error(`任务已经存在: ${id}`);
    const task = { id, title: title.trim(), completed: false };
    this.tasks.set(id, task);
    return { ...task };
  }

  complete(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`任务不存在: ${id}`);

    task.completed = true;
    return { ...task };
  }

  list(): Task[] {
    return [...this.tasks.values()].map((task) => ({ ...task }));
  }
}
