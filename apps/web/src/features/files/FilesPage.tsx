import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import {
  storage,
  fileError,
  sessionLost,
  joinPath as join,
  type FileStatus as Status,
} from "./storage";
import {
  UploadQueue,
  runBatch,
  type BatchResult,
  type Transfer,
} from "./transfers";
import UploadPanel from "./UploadPanel";
import {
  Badge,
  EditorDialog,
  button,
  card,
  input,
  primary,
} from "../samba/components";
import { displayDomain, type Editor } from "../samba/types";
import FileBrowser, { fileSize, type FileEntry } from "./FileBrowser";
import { Icon } from "./icons";
import { signOut } from "../../lib/auth-client";
import { useAuth } from "../../stores/auth";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useModules } from "../../stores/modules";
import { fileLocation } from "./locations";

export default function FilesPage() {
  const navigateTo = useNavigate();
  const { t } = useTranslation();
  const has = useAuth(s => s.has);
  const administrator = useAuth(s => s.user?.roles.includes("admin") === true);
  const directoryEnabled = useModules(s => s.features.directory);
  const fileAdministrator = administrator || has("samba:read");
  const canReadDirectory = directoryEnabled && has("samba:read");
  const canLinkIdentity = canReadDirectory && has("samba:manage");
  const [searchParams, setSearchParams] = useSearchParams();
  const clearLogin = useAuth((s) => s.clear);
  const directoryFilesReady = useAuth((s) => s.directoryFilesReady);
  const companyAccount = useAuth((s) => s.user?.passwordSource === "directory");
  const redirecting = useRef(false);
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [status, setStatus] = useState<Status | null>(null);
  const [password, setPassword] = useState("");
  const { share, path } = fileLocation(
    searchParams,
    status?.connected ? status.shares || [] : [],
  );
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [batch, setBatch] = useState<{
    share: string;
    path: string;
    entries: FileEntry[];
  } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const batchAbort = useRef<AbortController | null>(null);
  const browseAbort = useRef<AbortController | null>(null);
  const companyMode =
    companyAccount || status?.reconnectWithCompanyLogin === true;
  const fail = useCallback(
    (e: any) => {
      const message = fileError(e);
      setError(
        e.response?.status === 410 && companyMode
          ? ""
          : typeof message === "string"
            ? message
            : "文件请求失败",
      );
      if (e.response?.status === 410) {
        setStatus((s) => (s ? { ...s, connected: false } : s));
        setEntries([]);
        setPassword("");
      }
    },
    [companyMode],
  );
  const refreshStatus = useCallback(async () => {
    setCheckingStatus(true);
    try {
      const data = await storage.status();
      setStatus(data);
      setError("");
    } catch (e) {
      fail(e);
    } finally {
      setCheckingStatus(false);
    }
  }, [fail]);
  const refresh = useCallback(async () => {
    browseAbort.current?.abort();
    if (!status?.connected || !share) {
      setEntries([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    browseAbort.current = controller;
    setLoading(true);
    setEntries([]);
    try {
      const data = await storage.list({ share, path }, controller.signal);
      if (!controller.signal.aborted) setEntries(data);
    } catch (e) {
      if (!controller.signal.aborted) {
        setEntries([]);
        fail(e);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [status?.connected, share, path, fail]);
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);
  useEffect(() => {
    void refresh();
    return () => browseAbort.current?.abort();
  }, [refresh]);
  useEffect(() => {
    if (!status?.connected || !status.expiresAt) return;
    // The server may have renewed the transport after the Assay session slid.
    // Recheck authoritative status instead of expiring a healthy connection here.
    const timer = setTimeout(
      () => {
        void refreshStatus();
      },
      Math.max(1000, status.expiresAt * 1000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [status?.connected, status?.expiresAt, refreshStatus]);
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "visible" && !busy) void refreshStatus();
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [busy, refreshStatus]);
  const companyLogin = useCallback(async () => {
    if (redirecting.current) return;
    redirecting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await signOut();
      if (result.error) throw new Error("SIGN_OUT_FAILED");
      clearLogin();
      navigateTo("/login", { replace: true, state: { returnTo: "/files" } });
    } catch {
      redirecting.current = false;
      setError("暂时无法完成登录跳转，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }, [clearLogin, navigateTo]);
  useEffect(() => {
    if (
      status?.identity &&
      !status.connected &&
      companyMode &&
      directoryFilesReady !== false &&
      !checkingStatus &&
      !error
    )
      void companyLogin();
  }, [
    status,
    companyMode,
    directoryFilesReady,
    checkingStatus,
    error,
    companyLogin,
  ]);
  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await storage.connect(password);
      setStatus(data);
      setSearchParams({}, { replace: true });
    } catch (e) {
      fail(e);
    } finally {
      setPassword("");
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    setError("");
    queue.cancelAll();
    try {
      await storage.disconnect();
      setStatus((s) => (s ? { ...s, connected: false } : s));
      setEntries([]);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  // Queue callbacks always use the current directory/session, while each task retains its original destination.
  const settled = useRef<(task: Transfer, error?: unknown) => void>(() => {});
  settled.current = (task, error) => {
    if (sessionLost(error)) fail(error);
    if (task.state === "done") setNotice(`已上传 ${task.name}`);
    if (
      task.target.share === share &&
      task.target.path.split("/").slice(0, -1).join("/") === path
    )
      void refresh();
  };
  const [queue] = useState(
    () =>
      new UploadQueue({
        upload: storage.upload,
        error: fileError,
        fatal: sessionLost,
        settled: (task, error) => settled.current(task, error),
      }),
  );
  const transfers = useSyncExternalStore(queue.subscribe, queue.snapshot);
  const uploading = transfers.some(
    (task) => task.state === "queued" || task.state === "uploading",
  );
  useEffect(() => {
    queue.resume();
    return () => {
      queue.dispose();
      batchAbort.current?.abort();
    };
  }, [queue]);
  useEffect(() => {
    if (status && !status.connected) queue.cancelAll();
  }, [status?.connected, queue]);
  useEffect(() => {
    if (!uploading) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);
  const upload = (files: File[]) => {
    if (!status?.connected || !share || busy) return;
    setNotice("");
    setError(
      queue.enqueue(files, { share, path }, status.maxFileBytes || 0) || "",
    );
    if (uploadRef.current) uploadRef.current.value = "";
  };
  const openBatch = (action: "move" | "delete", selected: FileEntry[]) => {
    if (!selected.length || busy) return;
    setBatch({ share, path, entries: selected });
    setEditor({
      action: `batch-${action}`,
      title: action === "delete" ? "批量删除" : "批量移动",
      description:
        action === "delete"
          ? `确认删除选中的 ${selected.length} 项？非空文件夹不会递归删除。各项独立执行，部分失败时不会回滚或自动重试。`
          : `将选中的 ${selected.length} 项移动到当前共享目录内的目标文件夹。文件夹必须已存在，留空表示共享根目录；同名文件不会覆盖。`,
      values: { destination: path },
      fields:
        action === "delete"
          ? []
          : [
              {
                name: "destination",
                label: "目标文件夹路径",
                maxLength: 4096,
                optional: true,
              },
            ],
    });
  };
  const openCommand = (action: string, entry?: FileEntry) => {
    setBatch(null);
    setEditor({
      action,
      title:
        action === "mkdir"
          ? "新建文件夹"
          : action === "move"
            ? "移动或重命名"
            : "删除文件或空文件夹",
      description:
        action === "delete"
          ? `确认删除“${entry?.name}”？此操作不会递归删除非空文件夹。`
          : action === "move"
            ? "填写当前共享目录内的目标路径。目标已存在时不会覆盖。"
            : "在当前目录创建文件夹。",
      values: {
        path: entry ? join(path, entry.name) : "",
        destination: entry ? join(path, entry.name) : "",
      },
      fields:
        action === "delete"
          ? []
          : [
              {
                name: "destination",
                label: action === "mkdir" ? "文件夹名称" : "目标路径",
                maxLength: action === "mkdir" ? 255 : 4096,
              },
            ],
    });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editor || busy) return;
    const c = editor;
    setEditor({ ...c, error: undefined });
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const destination = String(c.values.destination || "");
      if (c.action === "mkdir" && destination.includes("/")) {
        setEditor({ ...c, error: "文件夹名称不能包含路径分隔符。" });
        return;
      }
      if (c.action.startsWith("batch-") && batch) {
        const action = c.action === "batch-move" ? "move" : "delete";
        if (
          action === "move" &&
          (destination.startsWith("/") ||
            destination.endsWith("/") ||
            destination
              .split("/")
              .some((part) => part === "." || part === ".."))
        ) {
          setEditor({
            ...c,
            error: "请填写共享目录内的相对文件夹路径，不要以斜杠开头或结尾。",
          });
          return;
        }
        setBatchResults([]);
        const controller = new AbortController();
        batchAbort.current = controller;
        await runBatch(
          batch.entries,
          (entry) =>
            storage.command({
              action,
              share: batch.share,
              path: join(batch.path, entry.name),
              ...(action === "move"
                ? { destination: join(destination, entry.name) }
                : {}),
            }),
          fileError,
          (e) => {
            if (sessionLost(e)) {
              fail(e);
              return true;
            }
            return false;
          },
          setBatchResults,
          controller.signal,
        );
        batchAbort.current = null;
        setEditor(null);
        setBatch(null);
        await refresh();
        return;
      }
      await storage.command({
        action: c.action as "mkdir" | "move" | "delete",
        share,
        path:
          c.action === "mkdir"
            ? join(path, destination)
            : String(c.values.path),
        ...(c.action === "move" ? { destination } : {}),
      });
      setEditor(null);
      setNotice("操作已完成");
      await refresh();
    } catch (e) {
      fail(e);
      setEditor({ ...c, error: fileError(e) });
    } finally {
      setBusy(false);
    }
  };
  const navigate = (nextShare: string, nextPath = "") => {
    if (busy) return;
    if (nextShare === share && nextPath === path) {
      if (nextShare) void refresh();
      return;
    }
    browseAbort.current?.abort();
    setEntries([]);
    setLoading(Boolean(nextShare));
    setSearchParams(
      nextShare
        ? { share: nextShare, ...(nextPath ? { path: nextPath } : {}) }
        : {},
    );
    setError("");
    setNotice("");
  };
  const download = (entry: FileEntry) =>
    storage.download({ share, path: join(path, entry.name) });
  const open = (entry: FileEntry) => {
    if (entry.blocked || busy) return;
    if (entry.shared) navigate(entry.name);
    else if (entry.directory) navigate(share, join(path, entry.name));
    else {
      const anchor = document.createElement("a");
      anchor.href = download(entry);
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    }
  };
  const sharedDirectories: FileEntry[] = (status?.shares || []).map((name) => ({
    name,
    directory: true,
    shared: true,
    size: 0,
    modified: 0,
    blocked: false,
  }));
  const serviceUnavailable = (
    <div className="flex justify-center py-8">
      <section className={card + " w-full max-w-lg space-y-4 p-8 text-center"}>
        <h2 className="font-semibold">文件服务暂不可用</h2>
        <p className="text-sm text-gray-500">
          请稍后重试，你仍可使用其他业务模块。
        </p>
        <button
          className={button}
          disabled={busy || checkingStatus}
          onClick={() => {
            if (companyMode && directoryFilesReady === false) void companyLogin();
            else void refreshStatus();
          }}
        >
          重试
        </button>
      </section>
    </div>
  );
  const verificationForm = (
    <div className="flex justify-center py-8">
      <form onSubmit={verify} className={card + " w-full max-w-lg space-y-4 p-8"}>
        <h2 className="font-semibold">验证自己的 AD 密码</h2>
        <p className="text-sm text-gray-500">
          连接后随当前 Assay 登录保留。AD 密码不写入数据库或日志。
        </p>
        <label className="block space-y-2 text-sm">
          <span>AD 密码</span>
          <input
            className={input}
            type="password"
            autoComplete="current-password"
            value={password}
            maxLength={512}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={busy}
          />
        </label>
        <button className={primary + " w-full"} disabled={busy}>
          {busy ? "正在验证…" : "验证并打开文件"}
        </button>
      </form>
    </div>
  );
  return (
    <div className="mx-auto max-w-[1500px] space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">共享文件</h1>
          <p className="mt-2 text-sm text-gray-500">
            浏览公司共享目录，集中管理你有权限访问的文件。
          </p>
        </div>
        {status?.identity && (
          <div className="flex flex-wrap items-center gap-3">
            <Badge>
              {displayDomain(status.identity.domain)} /{" "}
              {status.identity.accountName}
            </Badge>
            {status.connected && !companyMode && (
              <button className={button} onClick={disconnect} disabled={busy}>
                断开文件会话
              </button>
            )}
          </div>
        )}
      </div>
      {error && (!companyMode || status?.connected) && (
        <p
          role="alert"
          className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-lg bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950/30 dark:text-green-300"
        >
          {notice}
        </p>
      )}
      {!status ? (
        error ? (
          serviceUnavailable
        ) : (
          <p role="status" className="text-sm text-gray-500">
            正在加载文件…
          </p>
        )
      ) : !status.identity ? (
        <section className={card + " p-6"}>
          <h2 className="font-semibold">{fileAdministrator ? t("workbench.adminFilesUnlinkedTitle") : "尚未关联公司账号"}</h2>
          <p className="mt-2 text-sm leading-6 text-gray-500">
            {fileAdministrator ? t("workbench.adminFilesUnlinkedHint") : "请联系管理员关联你的 AD 员工账号，以访问获授权的共享文件。"}
          </p>
          {fileAdministrator && canReadDirectory && <div className="mt-5 flex flex-wrap gap-3">
            {canReadDirectory && <Link to="/samba/overview" className={primary}>{t("workbench.manageFiles")}</Link>}
            {canLinkIdentity && <Link to="/samba/bindings" className={button}>{t("workbench.linkPersonalFiles")}</Link>}
          </div>}
        </section>
      ) : !status.connected ? (
        companyMode ? (
          error || directoryFilesReady === false ? (
            serviceUnavailable
          ) : (
            <p role="status" className="text-sm text-gray-500">
              正在返回登录页…
            </p>
          )
        ) : (
          verificationForm
        )
      ) : (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <button
              className={button + " h-10 w-10 shrink-0 p-0"}
              aria-label="返回上一级"
              disabled={busy || !share}
              onClick={() =>
                path
                  ? navigate(share, path.split("/").slice(0, -1).join("/"))
                  : navigate("")
              }
            >
              <Icon name="back" />
            </button>
            <nav
              aria-label="文件路径"
              className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm"
            >
              <button
                disabled={busy}
                className={`min-h-10 rounded-lg px-2 ${!share ? "font-semibold text-gray-900 dark:text-gray-100" : "text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"}`}
                aria-current={!share ? "page" : undefined}
                onClick={() => navigate("")}
              >
                所有共享目录
              </button>
              {share && (
                <>
                  <Icon name="chevron" className="shrink-0 text-gray-400" />
                  <button
                    className="min-h-10 max-w-full truncate rounded-lg px-2 font-medium hover:bg-gray-100 dark:hover:bg-gray-800"
                    title={share}
                    disabled={busy}
                    aria-current={!path ? "page" : undefined}
                    onClick={() => navigate(share)}
                  >
                    {share}
                  </button>
                </>
              )}
              {path
                .split("/")
                .filter(Boolean)
                .map((part, i, parts) => (
                  <span
                    key={i}
                    className="flex min-w-0 max-w-full items-center gap-2"
                  >
                    <Icon name="chevron" className="shrink-0 text-gray-400" />
                    <button
                      className="min-h-10 min-w-0 truncate rounded-lg px-2 font-medium hover:bg-gray-100 dark:hover:bg-gray-800"
                      title={part}
                      disabled={busy}
                      aria-current={i === parts.length - 1 ? "page" : undefined}
                      onClick={() =>
                        navigate(share, parts.slice(0, i + 1).join("/"))
                      }
                    >
                      {part}
                    </button>
                  </span>
                ))}
            </nav>
            <span
              aria-live="polite"
              className="ml-auto shrink-0 text-xs text-gray-500"
            >
              {loading
                ? "正在读取目录…"
                : share
                  ? `共 ${entries.length} 项`
                  : `可访问共享 ${sharedDirectories.length} 个`}
            </span>
          </div>
          <UploadPanel tasks={transfers} queue={queue} />
          {batchResults.length > 0 && (
            <section
              aria-label="批量操作结果"
              className={card + " p-4 text-sm"}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex flex-wrap items-center gap-2 font-semibold">
                  批量操作结果
                  <Badge>{batchResults.filter((r) => r.state === "done").length} 项成功</Badge>
                  {batchResults.some((r) => r.state !== "done") && (
                    <Badge danger>
                      {batchResults.filter((r) => r.state !== "done").length} 项失败或未执行
                    </Badge>
                  )}
                </h2>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => setBatchResults([])}
                >
                  清除结果
                </button>
              </div>
              <ul className="mt-3 max-h-48 space-y-2 overflow-y-auto break-words rounded-lg bg-gray-50 p-3 dark:bg-gray-950/40">
                {batchResults.map((r) => (
                  <li
                    key={r.name}
                    className={
                      r.state === "done"
                        ? "text-gray-500"
                        : "text-red-600 dark:text-red-400"
                    }
                  >
                    {r.state === "done" ? "✓" : "✕"} {r.name}
                    {r.state !== "done" && r.message ? ` · ${r.message}` : ""}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <FileBrowser
            key={`${share}:${path}`}
            items={share ? entries : sharedDirectories}
            root={!share}
            loading={loading}
            busy={busy}
            open={open}
            command={openCommand}
            batchCommand={openBatch}
            upload={upload}
            dropError={setError}
            download={download}
            actions={
              <>
                <button
                  className={button}
                  disabled={busy || loading}
                  onClick={() => {
                    setError("");
                    void (share ? refresh() : refreshStatus());
                  }}
                >
                  <Icon name="refresh" />
                  刷新
                </button>
                {share && (
                  <>
                    <button
                      className={button}
                      disabled={busy || loading}
                      onClick={() => openCommand("mkdir")}
                    >
                      <Icon name="plus" />
                      <span className="hidden sm:inline">新建文件夹</span>
                      <span className="sr-only sm:hidden">新建文件夹</span>
                    </button>
                    <button
                      className={primary}
                      disabled={busy || loading}
                      onClick={() => uploadRef.current?.click()}
                    >
                      <Icon name="upload" />
                      上传文件
                    </button>
                  </>
                )}
              </>
            }
          />
          <input
            ref={uploadRef}
            className="hidden"
            type="file"
            multiple
            aria-label="选择上传文件"
            disabled={!share || busy}
            onChange={(e) => upload(Array.from(e.target.files || []))}
          />
          {share && (
            <p className="text-xs text-gray-500">
              单文件上传上限 {fileSize(status.maxFileBytes || 0)}
              ，支持多选或拖入文件上传。电脑端保存到共享目录后，点击“刷新”查看最新变化。
            </p>
          )}
        </>
      )}
      {editor && (
        <EditorDialog
          editor={editor}
          busy={busy}
          submitLabel="确认操作"
          setEditor={setEditor}
          submit={submit}
          cancel={() => {
            if (!busy) setEditor(null);
          }}
        />
      )}
    </div>
  );
}
