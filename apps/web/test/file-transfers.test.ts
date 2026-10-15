import { expect, test } from "bun:test";
import {
  UploadQueue,
  runBatch,
  type Transfer,
} from "../src/features/files/transfers";

const file = (name: string, size = 1) => new File([new Uint8Array(size)], name);
const folder = { share: "team", path: "reports" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const options = {
  error: () => "核对文件状态后再试",
  fatal: (error: unknown) => error === "expired",
  settled: (_task: Transfer, _error?: unknown) => {},
};

test("uploads are sequential and retain the destination selected at enqueue time", async () => {
  const first = deferred();
  const targets: string[] = [];
  const queue = new UploadQueue({
    ...options,
    upload: async (target, _file, _signal, progress) => {
      targets.push(target.share + "/" + target.path);
      progress(100);
      if (targets.length === 1) await first.promise;
    },
  });
  const original = { ...folder };
  queue.enqueue([file("a"), file("b")], original, 100);
  original.path = "another-folder";
  expect(targets).toEqual(["team/reports/a"]);
  expect(queue.snapshot().map((t) => t.state)).toEqual(["uploading", "queued"]);
  // Sending 100% of the bytes is not a successful server commit.
  expect(queue.snapshot()[0].progress).toBe(100);
  first.resolve();
  await tick();
  expect(targets).toEqual(["team/reports/a", "team/reports/b"]);
  expect(queue.snapshot().map((t) => t.state)).toEqual(["done", "done"]);
});

test("a failed write is reported once, never replayed, and does not lose subsequent uploads", async () => {
  const attempts: string[] = [];
  const queue = new UploadQueue({
    ...options,
    upload: async (_target, file) => {
      attempts.push(file.name);
      if (file.name === "conflict") throw new Error("uncertain or conflict");
    },
  });
  queue.enqueue([file("conflict"), file("next")], folder, 100);
  await tick();
  expect(attempts).toEqual(["conflict", "next"]);
  expect(queue.snapshot().map((t) => t.state)).toEqual(["failed", "done"]);
  queue.resume();
  await tick();
  expect(attempts.length).toBe(2);
});

test("cancelling a queued file never sends it; aborting an active file allows the next one to proceed", async () => {
  const sent: string[] = [];
  const queue = new UploadQueue({
    ...options,
    upload: async (_target, file, signal) => {
      sent.push(file.name);
      if (file.name === "active")
        await new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("abort")), {
            once: true,
          }),
        );
    },
  });
  queue.enqueue(
    [file("active"), file("queued-cancel"), file("next")],
    folder,
    100,
  );
  queue.cancel(queue.snapshot()[1].id);
  queue.cancel(queue.snapshot()[0].id);
  await tick();
  expect(sent).toEqual(["active", "next"]);
  expect(queue.snapshot().map((t) => t.state)).toEqual([
    "cancelled",
    "cancelled",
    "done",
  ]);
  expect(queue.snapshot()[0].message).toContain("核对");
});

test("an expired session cancels all remaining uploads without opening another connection", async () => {
  let count = 0;
  const queue = new UploadQueue({
    ...options,
    upload: async () => {
      count++;
      throw "expired";
    },
  });
  queue.enqueue([file("a"), file("b"), file("c")], folder, 100);
  await tick();
  expect(count).toBe(1);
  expect(queue.snapshot().map((t) => t.state)).toEqual([
    "failed",
    "cancelled",
    "cancelled",
  ]);
});

test("leaving the page aborts the active upload and prevents queued uploads and stale callbacks", async () => {
  let sent = 0,
    callbacks = 0;
  const queue = new UploadQueue({
    ...options,
    settled: () => {
      callbacks++;
    },
    upload: async (_target, _file, signal) => {
      sent++;
      await new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("abort")), {
          once: true,
        }),
      );
    },
  });
  queue.enqueue([file("a"), file("b")], folder, 100);
  queue.dispose();
  await tick();
  expect(sent).toBe(1);
  expect(callbacks).toBe(0);
  expect(queue.snapshot().every((t) => t.state === "cancelled")).toBe(true);
  // React StrictMode setup/cleanup may resume the same queue; cancelled writes stay cancelled.
  queue.resume();
  await tick();
  expect(sent).toBe(1);
});

test("invalid or oversized files are rejected individually; task history is bounded", async () => {
  const sent: string[] = [];
  const queue = new UploadQueue({
    ...options,
    upload: async (_target, file) => {
      sent.push(file.name);
    },
  });
  queue.enqueue(
    [file("large", 3), file("../invalid"), file("valid")],
    folder,
    2,
  );
  await tick();
  expect(sent).toEqual(["valid"]);
  expect(queue.snapshot().map((t) => t.state)).toEqual([
    "failed",
    "failed",
    "done",
  ]);
  expect(
    queue.enqueue(
      Array.from({ length: 98 }, () => file("other")),
      folder,
      2,
    ),
  ).toContain("100");
  expect(queue.snapshot().length).toBe(3);
  queue.clear();
  expect(queue.snapshot()).toEqual([]);
});

test("batch writes preserve per-file partial failures without rollback or automatic retries", async () => {
  const calls: string[] = [],
    updates: number[] = [];
  const result = await runBatch(
    [{ name: "a" }, { name: "denied" }, { name: "c" }],
    async (entry) => {
      calls.push(entry.name);
      if (entry.name === "denied") throw "denied";
    },
    options.error,
    options.fatal,
    (results) => updates.push(results.length),
  );
  expect(calls).toEqual(["a", "denied", "c"]);
  expect(result.map((r) => r.state)).toEqual(["done", "failed", "done"]);
  expect(updates).toEqual([1, 2, 3]);
});

test("batch writes stop immediately on session loss and identify unattempted files", async () => {
  const calls: string[] = [];
  const result = await runBatch(
    [{ name: "a" }, { name: "expired" }, { name: "c" }],
    async (entry) => {
      calls.push(entry.name);
      if (entry.name === "expired") throw "expired";
    },
    options.error,
    options.fatal,
    () => {},
  );
  expect(calls).toEqual(["a", "expired"]);
  expect(result.map((r) => r.state)).toEqual(["done", "failed", "skipped"]);
});

test("leaving the batch page lets the in-flight command finish but sends no further writes", async () => {
  const controller = new AbortController();
  const first = deferred();
  const calls: string[] = [];
  const batch = runBatch(
    [{ name: "a" }, { name: "b" }],
    async (entry) => {
      calls.push(entry.name);
      await first.promise;
    },
    options.error,
    options.fatal,
    () => {},
    controller.signal,
  );
  controller.abort();
  first.resolve();
  const result = await batch;
  expect(calls).toEqual(["a"]);
  expect(result.map((r) => r.state)).toEqual(["done", "skipped"]);
});
