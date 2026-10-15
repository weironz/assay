import type { FileLocation } from "./storage";

export type TransferState =
  "queued" | "uploading" | "done" | "failed" | "cancelled";
export interface Transfer {
  id: number;
  name: string;
  size: number;
  target: FileLocation;
  state: TransferState;
  progress: number;
  message?: string;
}
interface QueueOptions {
  upload: (
    target: FileLocation,
    file: File,
    signal: AbortSignal,
    progress: (value: number) => void,
  ) => Promise<void>;
  error: (error: unknown) => string;
  fatal: (error: unknown) => boolean;
  settled: (task: Transfer, error?: unknown) => void;
}
const pending = (task: Transfer) =>
  task.state === "queued" || task.state === "uploading";

/** Sequential, bounded uploads. No automatic write retries and no file bytes in persistent storage. */
export class UploadQueue {
  private tasks: Transfer[] = [];
  private files = new Map<number, File>();
  private listeners = new Set<() => void>();
  private active: { id: number; controller: AbortController } | null = null;
  private nextId = 0;
  private stopped = false;
  constructor(private options: QueueOptions) {}
  snapshot = () => this.tasks;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private patch(id: number, patch: Partial<Transfer>) {
    this.tasks = this.tasks.map((task) =>
      task.id === id ? { ...task, ...patch } : task,
    );
    this.emit();
  }
  resume() {
    this.stopped = false;
    void this.run();
  }
  enqueue(
    files: File[],
    folder: FileLocation,
    maxFileBytes: number,
  ): string | undefined {
    if (this.stopped || !folder.share) return "请先打开一个共享目录。";
    if (files.length + this.tasks.length > 100)
      return "上传列表最多保留 100 项，请先清除已结束任务。";
    const added = files.map((file) => {
      const id = ++this.nextId;
      const invalid =
        file.size > maxFileBytes
          ? "文件超过上传大小限制。"
          : !file.name ||
              file.name.length > 255 ||
              /[\\/:*?"<>|\x00-\x1f]/.test(file.name) ||
              /[. ]$/.test(file.name) ||
              file.name.startsWith(".assay-upload-")
            ? "文件名不符合共享目录的命名要求。"
            : undefined;
      if (!invalid) this.files.set(id, file);
      return {
        id,
        name: file.name,
        size: file.size,
        target: {
          share: folder.share,
          path: folder.path ? `${folder.path}/${file.name}` : file.name,
        },
        state: invalid ? ("failed" as const) : ("queued" as const),
        progress: 0,
        message: invalid,
      };
    });
    this.tasks = [...this.tasks, ...added];
    this.emit();
    void this.run();
  }
  cancel(id: number) {
    const task = this.tasks.find((task) => task.id === id);
    if (!task || !pending(task)) return;
    if (this.active?.id === id) this.active.controller.abort();
    else this.files.delete(id);
    this.patch(id, {
      state: "cancelled",
      message:
        task.state === "uploading"
          ? "已取消请求，请刷新核对文件状态。"
          : "已取消，尚未开始上传。",
    });
  }
  cancelAll() {
    for (const task of this.tasks) this.cancel(task.id);
  }
  clear() {
    this.tasks = this.tasks.filter(pending);
    this.emit();
  }
  dispose() {
    this.stopped = true;
    this.cancelAll();
  }
  private async run() {
    if (this.stopped || this.active) return;
    const task = this.tasks.find((task) => task.state === "queued");
    if (!task) return;
    const file = this.files.get(task.id)!;
    const controller = new AbortController();
    this.active = { id: task.id, controller };
    this.patch(task.id, { state: "uploading" });
    let error: unknown;
    try {
      await this.options.upload(
        task.target,
        file,
        controller.signal,
        (progress) => {
          if (!controller.signal.aborted) this.patch(task.id, { progress });
        },
      );
      if (!controller.signal.aborted)
        this.patch(task.id, { state: "done", progress: 100 });
    } catch (e) {
      error = e;
      if (!controller.signal.aborted) {
        this.patch(task.id, {
          state: "failed",
          message: this.options.error(e),
        });
        if (this.options.fatal(e)) this.cancelAll();
      }
    } finally {
      this.files.delete(task.id);
      this.active = null;
      const result = this.tasks.find((item) => item.id === task.id);
      if (!this.stopped && result) this.options.settled(result, error);
      void this.run();
    }
  }
}

export interface BatchResult {
  name: string;
  state: "done" | "failed" | "skipped";
  message?: string;
}
/** Partial completion is explicit. A lost session stops remaining writes; uncertain writes are never replayed. */
export async function runBatch<T extends { name: string }>(
  items: T[],
  operation: (item: T) => Promise<void>,
  error: (error: unknown) => string,
  fatal: (error: unknown) => boolean,
  update: (results: BatchResult[]) => void,
  signal?: AbortSignal,
): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  let stopped = false;
  for (const item of items) {
    if (stopped || signal?.aborted)
      results.push({
        name: item.name,
        state: "skipped",
        message: stopped ? "登录已失效，未执行。" : "操作已停止，未执行。",
      });
    else {
      try {
        await operation(item);
        results.push({ name: item.name, state: "done" });
      } catch (e) {
        results.push({ name: item.name, state: "failed", message: error(e) });
        stopped = fatal(e);
      }
    }
    update([...results]);
  }
  return results;
}
