import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { api, apiOrigin } from "../../lib/api";
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
import { useNavigate } from "react-router-dom";

interface Status {
  connected: boolean;
  identity: { accountName: string; domain: string } | null;
  shares?: string[];
  expiresAt?: number;
  followsWebSession?: boolean;
  reconnectWithCompanyLogin?: boolean;
  maxFileBytes?: number;
}

const join = (path: string, name: string) => (path ? `${path}/${name}` : name);
export default function FilesPage() {
  const navigateTo = useNavigate();
  const clearLogin = useAuth((s) => s.clear);
  const directoryFilesReady = useAuth((s) => s.directoryFilesReady);
  const companyAccount = useAuth((s) => s.user?.passwordSource === "directory");
  const redirecting = useRef(false);
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [status, setStatus] = useState<Status | null>(null);
  const [password, setPassword] = useState("");
  const [share, setShare] = useState("");
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const browseAbort = useRef<AbortController | null>(null);
  const companyMode =
    companyAccount || status?.reconnectWithCompanyLogin === true;
  const fail = useCallback(
    (e: any) => {
      const message =
        e.response?.data?.message || "请求未完成，请刷新核对文件状态后再试。";
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
      const { data } = await api.get<Status>("/files/status");
      setStatus(data);
      setError("");
      setShare((s) => (data.shares?.includes(s) ? s : ""));
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
      const { data } = await api.get("/files/list", {
        params: { share, path },
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setEntries(data.entries);
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
    return () => uploadAbort.current?.abort();
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
      const { data } = await api.post<Status>("/files/session", { password });
      setStatus(data);
      setShare("");
      setPath("");
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
    uploadAbort.current?.abort();
    try {
      await api.delete("/files/session");
      setStatus((s) => (s ? { ...s, connected: false } : s));
      setEntries([]);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const upload = async (file?: File) => {
    if (!file) return;
    if (file.size > (status?.maxFileBytes || 0)) {
      setError("文件超过上传大小限制。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    setProgress(0);
    const controller = new AbortController();
    uploadAbort.current = controller;
    try {
      await api.put("/files/content", file, {
        params: { share, path: join(path, file.name) },
        headers: { "Content-Type": "application/octet-stream" },
        signal: controller.signal,
        onUploadProgress: (event) =>
          setProgress(
            event.total ? Math.round((event.loaded * 100) / event.total) : 0,
          ),
      });
      setNotice(`已上传 ${file.name}`);
    } catch (e) {
      if (controller.signal.aborted)
        setError("上传已取消，临时文件将清理。请刷新确认后再试。");
      else fail(e);
    } finally {
      setProgress(null);
      setBusy(false);
      uploadAbort.current = null;
      if (uploadRef.current) uploadRef.current.value = "";
      await refresh();
    }
  };
  const openCommand = (action: string, entry?: FileEntry) => {
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
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const destination = String(c.values.destination || "");
      if (c.action === "mkdir" && destination.includes("/")) {
        setError("文件夹名称不能包含路径分隔符。");
        return;
      }
      await api.post("/files/commands", {
        action: c.action,
        share,
        path: c.action === "mkdir" ? join(path, destination) : c.values.path,
        ...(c.action === "move" ? { destination } : {}),
      });
      setEditor(null);
      setNotice("操作已完成");
      await refresh();
    } catch (e) {
      fail(e);
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
    setShare(nextShare);
    setPath(nextPath);
    setError("");
    setNotice("");
  };
  const download = (entry: FileEntry) =>
    `${apiOrigin}/api/files/content?${new URLSearchParams({ share, path: join(path, entry.name) })}`;
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
    <section className={card + " max-w-lg space-y-4 p-6"}>
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
  );
  const verificationForm = (
    <form onSubmit={verify} className={card + " max-w-lg space-y-4 p-6"}>
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
      <button className={primary} disabled={busy}>
        {busy ? "正在验证…" : "验证并打开文件"}
      </button>
    </form>
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
        <p role="status" className="text-sm text-green-700 dark:text-green-300">
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
          <h2 className="font-semibold">尚未关联公司账号</h2>
          <p className="mt-2 text-sm text-gray-500">
            请联系管理员，在“文件管理 → 登录账号关联”中关联你的 AD 员工账号。
          </p>
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
          </div>
          {progress !== null && (
            <div
              role="status"
              className={
                card + " flex flex-wrap items-center gap-3 p-4 text-sm"
              }
            >
              <Icon name="upload" />
              <span>
                正在上传 {progress}%
                {progress === 100 ? "，等待服务器完成…" : ""}
              </span>
              <progress
                className="h-2 min-w-24 flex-1"
                value={progress}
                max={100}
                aria-label="上传进度"
              />
              <button
                className={button}
                onClick={() => uploadAbort.current?.abort()}
              >
                取消上传
              </button>
            </div>
          )}
          <FileBrowser
            key={`${share}:${path}`}
            items={share ? entries : sharedDirectories}
            root={!share}
            loading={loading}
            busy={busy}
            open={open}
            command={openCommand}
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
            aria-label="选择上传文件"
            disabled={!share || busy}
            onChange={(e) => void upload(e.target.files?.[0])}
          />
          {share && (
            <p className="text-xs text-gray-500">
              单文件上传上限 {fileSize(status.maxFileBytes || 0)}
              。电脑端保存到共享目录后，点击“刷新”查看最新变化。
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
