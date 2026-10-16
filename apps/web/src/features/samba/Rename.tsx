import { useRef, useState, useEffect } from "react";
import { api } from "../../lib/api";
import { OperationError } from "../../lib/operation-error";
import { button, primary, input, card } from "./components";
import type { Workspace } from "./types";

type Preview = {
  oldName: string;
  newName: string;
  oldAddress: string;
  newAddress: string;
  activeSmbConnections: number;
  affectedShares: { name: string; path: string }[];
  validatedConfig: boolean;
};
export function Rename({
  kind,
  object,
  disabled,
  confirm,
}: {
  kind: "user" | "group" | "share";
  object: { id?: string; name: string; revision?: string };
  disabled: boolean;
  confirm: Workspace["confirm"];
}) {
  const [visible, setVisible] = useState(false),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [ack, setAck] = useState(false);
  const opener = useRef<HTMLButtonElement>(null),
    dialog = useRef<HTMLDivElement>(null),
    sequence = useRef(0);
  const title =
    kind === "user"
      ? "重命名登录账号"
      : kind === "group"
        ? "重命名用户组"
        : "重命名共享";
  const close = () => {
    sequence.current++;
    setVisible(false);
    opener.current?.focus();
  };
  useEffect(() => {
    if (visible)
      dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [visible]);
  const args = {
    kind,
    id: object.id,
    name,
    revision: object.revision,
    acknowledge_connections: ack,
  };
  async function check() {
    const request = ++sequence.current;
    setError("");
    setBusy(true);
    try {
      if (!/^[a-z][a-z0-9_-]{1,47}$/.test(name))
        throw Error(
          "名称需为 2–48 个字符，以小写字母开头，仅包含小写字母、数字、下划线或短横线。",
        );
      if (name === object.name) throw Error("请输入不同的新名称。");
      const r = await api.post("/samba/rename-preview", args);
      if (request === sequence.current) setPreview(r.data);
    } catch (e) {
      if (request === sequence.current) {
        const value = e as {
          response?: { data?: { code?: string } };
          message?: string;
        };
        setError(
          value.response?.data?.code
            ? new OperationError(value.response.data.code).message
            : value.message || "预检查失败，请刷新后重试",
        );
      }
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }
  return (
    <>
      <button
        ref={opener}
        className={button}
        disabled={disabled || !object.id || !object.revision}
        onClick={() => {
          setName("");
          setPreview(null);
          setAck(false);
          setError("");
          setVisible(true);
        }}
      >
        {title}
      </button>
      {visible && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !busy) close();
            if (e.key === "Tab") {
              const items = dialog.current?.querySelectorAll<HTMLElement>(
                "input,button:not(:disabled)",
              );
              if (items?.length) {
                if (e.shiftKey && document.activeElement === items[0]) {
                  e.preventDefault();
                  items[items.length - 1].focus();
                } else if (
                  !e.shiftKey &&
                  document.activeElement === items[items.length - 1]
                ) {
                  e.preventDefault();
                  items[0].focus();
                }
              }
            }
          }}
        >
          <div
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-title"
            className={
              card +
              " max-h-[90vh] w-full max-w-xl overflow-y-auto p-6 space-y-4"
            }
          >
            <h2 id="rename-title" className="text-xl font-semibold">
              {title}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {kind === "share"
                ? "只修改共享名称，实际文件目录不移动。文件内容、所有权、访问组和 Windows ACL 保持不变。"
                : kind === "user"
                  ? "修改原 AD 账号的登录名和 UPN；保留密码、姓名、组成员、身份关联和业务权限，内部 CN/DN 保持不变。"
                  : "修改原 AD 用户组名称，并同步共享准入规则中的引用；保留 SID、成员、说明及原有文件 ACL。"}
            </p>
            <p className="text-sm">
              当前名称：<strong>{object.name}</strong>
            </p>
            <label className="block text-sm">
              新名称
              <input
                className={input + " mt-2"}
                value={name}
                maxLength={48}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(e) => {
                  sequence.current++;
                  setBusy(false);
                  setName(e.target.value);
                  setPreview(null);
                  setAck(false);
                }}
              />
            </label>
            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}
            {preview && (
              <div
                className="space-y-3 rounded-lg bg-gray-50 p-4 text-sm dark:bg-gray-800"
                role="status"
              >
                <p>
                  旧{kind === "share" ? "共享地址" : "名称"}：
                  {kind === "share" ? preview.oldAddress : preview.oldName}
                </p>
                <p>
                  新{kind === "share" ? "共享地址" : "名称"}：
                  {kind === "share" ? preview.newAddress : preview.newName}
                </p>
                {kind === "share" && (
                  <p>实际文件目录不移动：{preview.affectedShares[0]?.path}</p>
                )}
                <p>
                  配置验证已通过。
                  {kind === "user"
                    ? "改名后使用新登录名和原密码；Windows 需断开旧连接、更新保存的凭据并重新连接。"
                    : kind === "share"
                      ? "请通知员工更新快捷方式和映射盘。旧连接可能暂时保留旧入口，重新连接后使用新名称。"
                      : "已有 SMB 会话可能保留旧的组信息，员工重新连接后生效。"}
                </p>
                <p>
                  服务器当前有 {preview.activeSmbConnections} 条 SMB
                  连接，可能包含已打开的文件。操作不会强制关闭文件或重启 AD。
                </p>
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                  />
                  我已了解连接影响，并已安排员工在合适时间重新连接。
                </label>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button className={button} disabled={busy} onClick={close}>
                取消
              </button>
              {preview ? (
                <button
                  className={primary}
                  disabled={!ack || busy}
                  onClick={() => {
                    close();
                    confirm(title, `${kind}.rename`, args);
                  }}
                >
                  确认重命名
                </button>
              ) : (
                <button
                  className={primary}
                  disabled={busy}
                  onClick={() => void check()}
                >
                  {busy ? "正在预检查…" : "预检查"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
