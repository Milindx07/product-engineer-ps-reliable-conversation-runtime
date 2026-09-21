import type { Scheduler, SchedulerHandle } from "./domain.js";

export class RealScheduler implements Scheduler {
  private nextId = 1;
  private readonly handles = new Map<number, NodeJS.Timeout>();

  setTimeout(callback: () => void, ms: number): SchedulerHandle {
    const id = this.nextId++;
    const timeout = setTimeout(() => {
      this.handles.delete(id);
      callback();
    }, ms);
    this.handles.set(id, timeout);
    return { id };
  }

  clearTimeout(handle: SchedulerHandle): void {
    const timeout = this.handles.get(handle.id);
    if (timeout) {
      clearTimeout(timeout);
      this.handles.delete(handle.id);
    }
  }
}

export class ManualClock implements Scheduler {
  private now = 0;
  private nextId = 1;
  private readonly tasks = new Map<
    number,
    { dueAt: number; callback: () => void; active: boolean }
  >();

  setTimeout(callback: () => void, ms: number): SchedulerHandle {
    const id = this.nextId++;
    this.tasks.set(id, {
      dueAt: this.now + ms,
      callback,
      active: true,
    });
    return { id };
  }

  clearTimeout(handle: SchedulerHandle): void {
    const task = this.tasks.get(handle.id);
    if (task) {
      task.active = false;
      this.tasks.delete(handle.id);
    }
  }

  tick(ms: number): void {
    this.now += ms;
    const dueTasks = [...this.tasks.entries()]
      .filter(([, task]) => task.active && task.dueAt <= this.now)
      .sort((a, b) => a[1].dueAt - b[1].dueAt);

    for (const [id, task] of dueTasks) {
      if (!task.active || !this.tasks.has(id)) {
        continue;
      }
      this.tasks.delete(id);
      task.active = false;
      task.callback();
    }
  }
}
