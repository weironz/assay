import { button, card } from "../samba/components";
import { fileSize } from "./FileBrowser";
import type { Transfer, UploadQueue } from "./transfers";
const labels = {
  queued: "等待上传",
  uploading: "正在上传",
  done: "上传完成",
  failed: "上传失败",
  cancelled: "已取消",
};
export default function UploadPanel({
  tasks,
  queue,
}: {
  tasks: Transfer[];
  queue: UploadQueue;
}) {
  if (!tasks.length) return null;
  const active = tasks.filter(
    (task) => task.state === "queued" || task.state === "uploading",
  ).length;
  return (
    <section aria-label="上传任务" className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 p-4 dark:border-gray-800">
        <h2 className="text-sm font-semibold">
          上传任务{" "}
          <span className="font-normal text-gray-500">
            {active ? `${active} 项待完成` : "已结束"}
          </span>
        </h2>
        <div className="flex flex-wrap gap-2">
          {active > 0 && (
            <button className={button} onClick={() => queue.cancelAll()}>
              取消全部上传
            </button>
          )}
          <button
            className={button}
            disabled={active === tasks.length}
            onClick={() => queue.clear()}
          >
            清除已结束任务
          </button>
        </div>
      </div>
      <ul className="max-h-64 divide-y divide-gray-100 overflow-y-auto p-4 dark:divide-gray-800">
        {tasks.map((task) => (
          <li
            key={task.id}
            aria-label={`上传：${task.name}`}
            className="flex min-w-0 items-center gap-3 py-3 text-sm"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <p className="truncate font-medium" title={task.name}>
                {task.name}{" "}
                <span className="text-xs font-normal text-gray-500">
                  {fileSize(task.size)}
                </span>
              </p>
              <p
                className="truncate text-xs text-gray-500"
                title={`${task.target.share}/${task.target.path}`}
              >
                目标：{task.target.share}/{task.target.path}
              </p>
              <p
                className={
                  task.state === "failed"
                    ? "text-xs text-red-600 dark:text-red-400"
                    : "text-xs text-gray-500"
                }
              >
                {labels[task.state]}
                {task.state === "uploading"
                  ? ` ${task.progress}%${task.progress === 100 ? "，等待服务器完成…" : ""}`
                  : ""}
                {task.message ? ` · ${task.message}` : ""}
              </p>
              {task.state === "uploading" && (
                <progress
                  className="h-1.5 w-full"
                  aria-label={`${task.name} 上传进度`}
                  max={100}
                  value={task.progress}
                />
              )}
            </div>
            {(task.state === "queued" || task.state === "uploading") && (
              <button
                className={button + " shrink-0"}
                aria-label={`取消上传：${task.name}`}
                onClick={() => queue.cancel(task.id)}
              >
                取消
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="px-4 pb-4 text-xs text-gray-500">
        离开文件管理或关闭页面会取消未完成的上传。取消或失败后，请刷新核对结果；同名文件不会覆盖。
      </p>
    </section>
  );
}
