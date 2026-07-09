import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  useTicket,
  useTransition,
  useAssign,
  useAddMessage,
  useAssignees,
  useAttachments,
  useHistory,
  useUpdateTicket,
  useUpdateMessage,
  uploadAttachment,
  attachmentUrl,
  Attachment,
} from '../features/tickets/api';
import { useQueryClient } from '@tanstack/react-query';
import {
  STATUS_LABEL,
  STATUS_COLOR,
  PRIORITY_LABEL,
  PRIORITY_COLOR,
  ACTION_LABEL,
} from '../lib/ticket-meta';
import { renderHtml } from '../lib/sanitize';
import { useAuth } from '../stores/auth';
import RichEditor from '../components/RichEditor';
import SlaBadge from '../components/SlaBadge';

const HISTORY_ACTION: Record<string, string> = {
  CREATE: '创建工单',
  ASSIGN: '指派',
  TRANSITION: '状态变更',
  MESSAGE: '回复/备注',
  UPDATE: '编辑',
  ATTACH: '附件',
};

export default function TicketDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { user, has } = useAuth();
  const { data: t, isLoading } = useTicket(id);
  const transition = useTransition();
  const assign = useAssign();
  const addMessage = useAddMessage();
  const { data: assignees } = useAssignees();
  const { data: attachments } = useAttachments(id);
  const { data: history } = useHistory(id);
  const updateTicket = useUpdateTicket();
  const updateMessage = useUpdateMessage();

  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [assigneeId, setAssigneeId] = useState('');
  const [editorKey, setEditorKey] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [msgDraft, setMsgDraft] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  if (isLoading || !t) return <div className="text-gray-400">加载中…</div>;

  const isStaff =
    user?.roles.includes('admin') ||
    user?.roles.includes('supervisor') ||
    user?.roles.includes('handler');
  const isSupervisorOrAdmin =
    !!user?.roles.includes('admin') || !!user?.roles.includes('supervisor');
  const canAssign =
    has('ticket:assign') && ['NEW', 'REOPENED'].includes(t.status);
  const canEditTicket =
    has('ticket:update') && (isStaff || t.requester?.id === user?.id);

  const saveTitle = () => {
    const v = titleDraft.trim();
    if (!v) return;
    updateTicket.mutate(
      { id, arg: { title: v } },
      { onSuccess: () => setEditingTitle(false) },
    );
  };
  const saveMsg = () => {
    if (!editingMsgId || !msgDraft.replace(/<[^>]*>/g, '').trim()) return;
    updateMessage.mutate(
      { id, arg: { messageId: editingMsgId, body: msgDraft } },
      { onSuccess: () => setEditingMsgId(null) },
    );
  };
  const uploadImg = async (file: File) => attachmentUrl(await uploadAttachment(id, file));

  const plain = reply.replace(/<[^>]*>/g, '').trim();

  const submitReply = () => {
    if (!plain) return;
    addMessage.mutate(
      { id, arg: { body: reply, isInternal: internal } },
      {
        onSuccess: () => {
          setReply('');
          setEditorKey((k) => k + 1); // 重挂载清空编辑器
          qc.invalidateQueries({ queryKey: ['attachments', id] });
        },
      },
    );
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const f of Array.from(files)) await uploadAttachment(id, f);
    qc.invalidateQueries({ queryKey: ['attachments', id] });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/tickets" className="text-sm text-blue-600 hover:underline">
          ← 返回
        </Link>
        <span className="font-mono text-xs text-gray-400">{t.ticketNo}</span>
        <span className={`inline-block px-2 py-0.5 rounded text-xs ${STATUS_COLOR[t.status]}`}>
          {STATUS_LABEL[t.status]}
        </span>
      </div>
      {editingTitle ? (
        <div className="flex items-center gap-2">
          <input
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            className="flex-1 text-xl font-semibold rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1"
            autoFocus
          />
          <button
            onClick={saveTitle}
            className="rounded-md bg-blue-600 text-white px-3 py-1.5 text-sm hover:bg-blue-700"
          >
            保存
          </button>
          <button
            onClick={() => setEditingTitle(false)}
            className="rounded-md border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm"
          >
            取消
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">{t.title}</h1>
          {canEditTicket && (
            <button
              onClick={() => {
                setTitleDraft(t.title);
                setEditingTitle(true);
              }}
              className="text-xs text-blue-600 hover:underline"
            >
              编辑
            </button>
          )}
        </div>
      )}

      {/* 状态流转 + 指派 */}
      <div className="flex flex-wrap items-center gap-2">
        {t.availableActions.map((a) => (
          <button
            key={a}
            disabled={transition.isPending}
            onClick={() => transition.mutate({ id, arg: a })}
            className="rounded-md border border-blue-600 text-blue-600 px-3 py-1.5 text-sm hover:bg-blue-600 hover:text-white disabled:opacity-50"
          >
            {ACTION_LABEL[a] ?? a}
          </button>
        ))}
        {canAssign && (
          <div className="flex items-center gap-2">
            <select
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm"
            >
              <option value="">选择处理人…</option>
              {assignees?.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
            <button
              disabled={!assigneeId || assign.isPending}
              onClick={() => assign.mutate({ id, arg: { assigneeId } })}
              className="rounded-md bg-blue-600 text-white px-3 py-1.5 text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              指派
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* 中栏 */}
        <div className="lg:col-span-2 space-y-3">
          <div className="space-y-3">
            {t.messages.map((m) => {
              const canEditMsg = m.author.id === user?.id || isSupervisorOrAdmin;
              const editing = editingMsgId === m.id;
              return (
                <div
                  key={m.id}
                  className={`rounded-lg border p-3 ${
                    m.isInternal
                      ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40'
                      : 'border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs mb-2">
                    <span className="font-medium text-gray-700 dark:text-gray-300">
                      {m.author.name}
                      {m.isInternal && <span className="ml-2 text-amber-600">内部备注</span>}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-gray-400">
                        {new Date(m.createdAt).toLocaleString()}
                      </span>
                      {canEditMsg && !editing && (
                        <button
                          onClick={() => {
                            setMsgDraft(m.body);
                            setEditingMsgId(m.id);
                          }}
                          className="text-blue-600 hover:underline"
                        >
                          编辑
                        </button>
                      )}
                    </span>
                  </div>
                  {editing ? (
                    <div className="space-y-2">
                      <RichEditor
                        content={m.body}
                        minHeight={80}
                        onChange={setMsgDraft}
                        onUploadImage={uploadImg}
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => setEditingMsgId(null)}
                          className="rounded-md border border-gray-300 dark:border-gray-700 px-3 py-1 text-sm"
                        >
                          取消
                        </button>
                        <button
                          onClick={saveMsg}
                          disabled={updateMessage.isPending}
                          className="rounded-md bg-blue-600 text-white px-3 py-1 text-sm hover:bg-blue-700 disabled:opacity-50"
                        >
                          保存
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* 服务端已消毒；此处再经 DOMPurify 二次消毒后渲染 */
                    <div
                      className="rich text-sm text-gray-800 dark:text-gray-200"
                      dangerouslySetInnerHTML={renderHtml(m.body)}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* 回复框（富文本） */}
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 space-y-2">
            <RichEditor
              key={editorKey}
              placeholder="输入回复…（支持 Markdown 快捷输入与插图）"
              onChange={setReply}
              onUploadImage={async (file) => {
                const a = await uploadAttachment(id, file);
                return attachmentUrl(a);
              }}
            />
            <div className="flex items-center justify-between">
              {isStaff ? (
                <label className="flex items-center gap-1 text-sm text-gray-500">
                  <input
                    type="checkbox"
                    checked={internal}
                    onChange={(e) => setInternal(e.target.checked)}
                  />
                  内部备注（提单人不可见）
                </label>
              ) : (
                <span />
              )}
              <button
                disabled={addMessage.isPending || !plain}
                onClick={submitReply}
                className="rounded-md bg-blue-600 text-white px-4 py-1.5 text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {internal ? '添加内部备注' : '回复'}
              </button>
            </div>
          </div>
        </div>

        {/* 右栏 */}
        <div className="space-y-3 text-sm">
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3">
            <Meta label="状态">
              <span className={`inline-block px-2 py-0.5 rounded text-xs ${STATUS_COLOR[t.status]}`}>
                {STATUS_LABEL[t.status]}
              </span>
            </Meta>
            <Meta label="优先级">
              <span className={PRIORITY_COLOR[t.priority]}>{PRIORITY_LABEL[t.priority]}</span>
            </Meta>
            <Meta label="提单人">{t.requester?.name}</Meta>
            <Meta label="处理人">{t.assignee?.name ?? '未指派'}</Meta>
            <Meta label="队列">{t.queue?.name ?? '—'}</Meta>
            <Meta label="类型">{t.type?.name ?? '—'}</Meta>
            <Meta label="分类">{t.category?.name ?? '—'}</Meta>
            <Meta label="SLA 剩余">
              <SlaBadge slaDueAt={t.slaDueAt} status={t.status} />
              {!t.slaDueAt && '—'}
            </Meta>
            <Meta label="SLA 截止">
              {t.slaDueAt ? new Date(t.slaDueAt).toLocaleString() : '—'}
            </Meta>
            <Meta label="创建时间">{new Date(t.createdAt).toLocaleString()}</Meta>
          </div>

          {/* 附件 */}
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-gray-500">附件</span>
              <button
                onClick={() => fileRef.current?.click()}
                className="text-blue-600 text-xs hover:underline"
              >
                + 上传
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                onChange={(e) => uploadFiles(e.target.files)}
              />
            </div>
            {attachments?.length ? (
              <ul className="space-y-1">
                {attachments.map((a: Attachment) => (
                  <li key={a.id} className="text-xs">
                    <a
                      href={attachmentUrl(a)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 hover:underline break-all"
                    >
                      {a.fileName}
                    </a>
                    <span className="text-gray-400 ml-1">
                      ({Math.ceil(a.fileSize / 1024)} KB)
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-gray-400">暂无附件</p>
            )}
          </div>

          {/* 操作历史 */}
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
            <button
              onClick={() => setShowHistory((s) => !s)}
              className="text-gray-500 text-sm w-full text-left"
            >
              操作历史 ({history?.length ?? 0}) {showHistory ? '▲' : '▼'}
            </button>
            {showHistory && (
              <ul className="mt-2 space-y-2">
                {history?.map((h) => (
                  <li key={h.id} className="text-xs text-gray-500 flex gap-2">
                    <span className="text-gray-400 shrink-0">
                      {new Date(h.createdAt).toLocaleString()}
                    </span>
                    <span>
                      <b>{h.user.name}</b> {HISTORY_ACTION[h.action] ?? h.action}
                      {h.newValue ? `：${h.newValue}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-gray-400">{label}</span>
      <span className="text-gray-700 dark:text-gray-200 text-right">{children}</span>
    </div>
  );
}
