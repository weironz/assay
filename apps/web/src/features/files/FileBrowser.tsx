import { useEffect, useRef, useState, type ReactNode } from "react";
import { button, input } from "../samba/components";
import { FileIcon, Icon } from "./icons";

export interface FileEntry {
  name: string;
  directory: boolean;
  size: number;
  modified: number;
  blocked: boolean;
  shared?: boolean;
}
export const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const date = (seconds: number) => new Date(seconds * 1000).toLocaleString();
const viewKey = "assay:files:view";
type Sort = "name" | "modified" | "size";
const pageSize = 48;
const menuCoordinates = (rect: DOMRect, height: number) => ({
  left: Math.max(12, Math.min(rect.right - 192, window.innerWidth - 204)),
  top:
    rect.bottom + height + 8 > window.innerHeight
      ? Math.max(12, rect.top - height - 4)
      : rect.bottom + 4,
});

export default function FileBrowser({
  items,
  root,
  loading,
  busy,
  actions,
  open,
  command,
  download,
}: {
  items: FileEntry[];
  root: boolean;
  loading: boolean;
  busy: boolean;
  actions: ReactNode;
  open: (entry: FileEntry) => void;
  command: (action: string, entry: FileEntry) => void;
  download: (entry: FileEntry) => string;
}) {
  const [view, setView] = useState<"grid" | "list">(() => {
    try {
      return localStorage.getItem(viewKey) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [descending, setDescending] = useState(false);
  const [page, setPage] = useState(1);
  const [menu, setMenu] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    try {
      localStorage.setItem(viewKey, view);
    } catch {
      /* Layout preference is optional. */
    }
  }, [view]);
  useEffect(() => {
    if (menu === null) return;
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(null);
        triggerRef.current?.focus();
      }
    };
    const reposition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect || rect.bottom < 0 || rect.top > window.innerHeight) {
        setMenu(null);
        return;
      }
      const height =
        menuRef.current
          ?.querySelector('[role="group"]')
          ?.getBoundingClientRect().height || 144;
      setMenuPosition(menuCoordinates(rect, height));
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);
  const filtered = items
    .filter((e) =>
      e.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    )
    .sort((a, b) => {
      const folders = Number(b.directory) - Number(a.directory);
      const compared =
        sort === "name"
          ? a.name.localeCompare(b.name, undefined, { numeric: true })
          : a[sort] - b[sort];
      return (
        folders ||
        (descending ? -1 : 1) * (compared || a.name.localeCompare(b.name))
      );
    });
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * pageSize, current * pageSize);
  const changeSort = (value: Sort) => {
    setDescending(sort === value ? !descending : value === "modified");
    setSort(value);
    setMenu(null);
    setPage(1);
  };
  const description = (e: FileEntry) =>
    e.blocked
      ? "不支持访问"
      : e.shared
        ? "共享目录"
        : e.directory
          ? "文件夹"
          : fileSize(e.size);
  const controls = (entry: FileEntry) =>
    entry.shared ? null : (
      <div
        className="relative shrink-0"
        ref={menu === entry.name ? menuRef : undefined}
      >
        <button
          ref={menu === entry.name ? triggerRef : undefined}
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800"
          aria-label={`更多操作：${entry.name}`}
          aria-expanded={menu === entry.name}
          disabled={busy || entry.blocked}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const height = entry.directory ? 100 : 144;
            setMenuPosition(menuCoordinates(rect, height));
            setMenu(menu === entry.name ? null : entry.name);
          }}
        >
          <Icon name="more" strokeWidth="3" />
        </button>
        {menu === entry.name && (
          <div
            role="group"
            aria-label={`${entry.name} 的操作`}
            style={menuPosition}
            className="fixed z-30 w-48 rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg dark:border-gray-700 dark:bg-gray-900"
            onBlur={(e) => {
              if (
                !e.currentTarget.parentElement?.contains(
                  e.relatedTarget as Node,
                )
              )
                setMenu(null);
            }}
          >
            {!entry.directory && (
              <a
                className="flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
                href={download(entry)}
                onClick={() => setMenu(null)}
              >
                <Icon name="download" />
                下载
              </a>
            )}
            <button
              className="flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
              onClick={() => {
                setMenu(null);
                command("move", entry);
              }}
            >
              <Icon name="move" />
              移动 / 重命名
            </button>
            <button
              className="flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
              onClick={() => {
                setMenu(null);
                command("delete", entry);
              }}
            >
              <Icon name="trash" />
              删除
            </button>
          </div>
        )}
      </div>
    );
  const sortLabel = (value: Sort, label: string) => (
    <button
      className="inline-flex min-h-10 items-center gap-2 text-sm"
      onClick={() => changeSort(value)}
    >
      {label}
      {sort === value && (
        <span aria-hidden="true">{descending ? "↓" : "↑"}</span>
      )}
      <span className="sr-only">
        ，点击
        {(sort === value ? !descending : value === "modified")
          ? "降序"
          : "升序"}
        排序
      </span>
    </button>
  );
  return (
    <section
      aria-label={root ? "共享目录浏览器" : "文件浏览器"}
      className="min-w-0 rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 p-4 sm:px-6 dark:border-gray-800">
        <label className="relative w-full min-w-0 sm:w-auto sm:flex-1 sm:max-w-80">
          <span className="sr-only">
            {root ? "搜索共享目录" : "搜索当前文件夹"}
          </span>
          <Icon
            name="search"
            className="pointer-events-none absolute left-3 top-3.5 text-gray-400"
          />
          <input
            className={input + " pl-10 pr-10"}
            type="search"
            placeholder={root ? "搜索共享目录" : "搜索当前文件夹"}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
              setMenu(null);
            }}
          />
          {query && (
            <button
              aria-label="清除搜索"
              className="absolute right-1 top-1 flex h-9 w-9 items-center justify-center rounded-lg text-gray-500"
              onClick={() => {
                setQuery("");
                setPage(1);
              }}
            >
              <Icon name="close" />
            </button>
          )}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <div
            role="group"
            aria-label="显示方式"
            className="flex rounded-lg border border-gray-200 p-1 dark:border-gray-700"
          >
            {(["grid", "list"] as const).map((v) => (
              <button
                key={v}
                aria-label={v === "grid" ? "网格视图" : "列表视图"}
                aria-pressed={view === v}
                className={`flex h-8 w-9 items-center justify-center rounded-md ${view === v ? "bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-300" : "text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"}`}
                onClick={() => {
                  setView(v);
                  setMenu(null);
                }}
              >
                <Icon name={v} />
              </button>
            ))}
          </div>
        </div>
      </div>
      <div aria-busy={loading} className="min-h-80 p-4 sm:p-6">
        {loading ? (
          <div
            role="status"
            className="flex min-h-64 items-center justify-center gap-3 text-sm text-gray-500"
          >
            <Icon name="refresh" className="animate-spin" />
            正在加载文件…
          </div>
        ) : !visible.length ? (
          <div className="flex min-h-64 flex-col items-center justify-center text-center">
            <FileIcon name="" directory className="mb-5 h-20 w-24 opacity-70" />
            <h2 className="font-medium">
              {query
                ? "没有匹配的结果"
                : root
                  ? "暂无可访问的共享目录"
                  : "此文件夹为空"}
            </h2>
            <p className="mt-2 max-w-sm text-sm text-gray-500">
              {query
                ? "试试其他名称，或清除搜索条件。"
                : root
                  ? "请联系管理员分配共享目录的访问权限。"
                  : "可以上传文件，或新建文件夹开始整理。"}
            </p>
          </div>
        ) : view === "grid" ? (
          <>
            <div className="mb-4 flex items-center justify-between text-gray-500">
              {sortLabel("name", "名称")}
              <span className="text-xs">
                {root ? "共享目录" : "文件夹优先"}
              </span>
            </div>
            <ul
              aria-label={root ? "共享目录" : "文件"}
              className="grid grid-cols-2 gap-x-4 gap-y-5 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
            >
              {visible.map((entry) => (
                <li
                  key={entry.name}
                  className="group min-w-0 rounded-xl border border-transparent transition hover:border-gray-200 dark:hover:border-gray-700"
                >
                  <button
                    className="flex aspect-[1.6] w-full items-center justify-center rounded-xl bg-gray-50 transition hover:bg-blue-50 disabled:cursor-default dark:bg-gray-800/60 dark:hover:bg-gray-800"
                    aria-label={
                      entry.directory
                        ? `打开文件夹：${entry.name}`
                        : `下载文件：${entry.name}`
                    }
                    disabled={busy || entry.blocked}
                    onClick={() => open(entry)}
                  >
                    <FileIcon
                      name={entry.name}
                      directory={entry.directory}
                      shared={entry.shared}
                      className={`h-20 w-24 max-w-[65%] sm:h-24 sm:w-28 ${entry.blocked ? "opacity-40" : ""}`}
                    />
                  </button>
                  <div className="flex items-start justify-between gap-1 pb-2 pl-2 pt-2">
                    <div className="min-w-0">
                      <button
                        className="block w-full truncate py-1 text-left text-sm font-medium hover:underline disabled:no-underline"
                        title={entry.name}
                        disabled={busy || entry.blocked}
                        onClick={() => open(entry)}
                      >
                        {entry.name}
                      </button>
                      <p className="mt-0.5 truncate text-xs text-gray-500">
                        {description(entry)}
                      </p>
                      {entry.modified > 0 && (
                        <p
                          className="mt-1 truncate text-xs text-gray-400"
                          title={date(entry.modified)}
                        >
                          {new Date(entry.modified * 1000).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                    {controls(entry)}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="w-full">
            <table
              aria-label={root ? "共享目录" : "文件"}
              className="w-full table-fixed text-left text-sm"
            >
              <thead className="border-b border-gray-100 text-gray-500 dark:border-gray-800">
                <tr>
                  <th
                    scope="col"
                    className="font-normal"
                    aria-sort={
                      sort === "name"
                        ? descending
                          ? "descending"
                          : "ascending"
                        : "none"
                    }
                  >
                    {sortLabel("name", "名称")}
                  </th>
                  <th
                    scope="col"
                    className="hidden w-44 font-normal lg:table-cell"
                    aria-sort={
                      sort === "modified"
                        ? descending
                          ? "descending"
                          : "ascending"
                        : "none"
                    }
                  >
                    {!root && sortLabel("modified", "修改时间")}
                  </th>
                  <th
                    scope="col"
                    className="hidden w-24 font-normal sm:table-cell"
                    aria-sort={
                      sort === "size"
                        ? descending
                          ? "descending"
                          : "ascending"
                        : "none"
                    }
                  >
                    {!root && sortLabel("size", "大小")}
                  </th>
                  <th scope="col" className="w-10">
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((entry) => (
                  <tr
                    key={entry.name}
                    className="border-b border-gray-100 last:border-0 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/40"
                  >
                    <td className="py-3 pr-2">
                      <button
                        className="flex w-full min-w-0 items-center gap-3 text-left disabled:cursor-default disabled:opacity-50"
                        aria-label={
                          entry.directory
                            ? `打开文件夹：${entry.name}`
                            : `下载文件：${entry.name}`
                        }
                        disabled={busy || entry.blocked}
                        onClick={() => open(entry)}
                      >
                        <FileIcon
                          name={entry.name}
                          directory={entry.directory}
                          shared={entry.shared}
                          className="h-10 w-11 shrink-0"
                        />
                        <span className="min-w-0">
                          <span
                            className="block truncate font-medium"
                            title={entry.name}
                          >
                            {entry.name}
                          </span>
                          <span className="mt-1 block truncate text-xs text-gray-500">
                            {description(entry)}
                          </span>
                        </span>
                      </button>
                    </td>
                    <td className="hidden py-3 text-xs text-gray-500 lg:table-cell">
                      {entry.modified > 0 ? date(entry.modified) : ""}
                    </td>
                    <td className="hidden py-3 text-xs text-gray-500 sm:table-cell">
                      {!entry.directory && fileSize(entry.size)}
                    </td>
                    <td className="py-3">{controls(entry)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-4 py-3 text-xs text-gray-500 sm:px-6 dark:border-gray-800">
        <span role="status">
          {loading
            ? "正在读取目录"
            : `${filtered.length} 个${root ? "共享目录" : "项目"}${query ? `（共 ${items.length} 个）` : ""}`}
        </span>
        {pages > 1 && (
          <div className="flex items-center gap-2">
            <button
              className={button}
              disabled={current === 1}
              onClick={() => {
                setPage(current - 1);
                setMenu(null);
              }}
            >
              上一页
            </button>
            <span>
              {current} / {pages}
            </span>
            <button
              className={button}
              disabled={current === pages}
              onClick={() => {
                setPage(current + 1);
                setMenu(null);
              }}
            >
              下一页
            </button>
          </div>
        )}
        <span>
          {root
            ? "仅显示当前账号可访问的共享目录"
            : "文件访问权限由公司目录策略控制"}
        </span>
      </div>
    </section>
  );
}
