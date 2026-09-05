import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
  useAddParticipant,
  useRemoveParticipant,
  useParticipantCandidates,
  uploadAttachment,
  attachmentUrl,
  Attachment,
} from '../features/tickets/api';
import { useQueryClient } from '@tanstack/react-query';
import {
  STATUS_COLOR,
  PRIORITY_COLOR,
  statusLabel,
  priorityLabel,
  actionLabel,
  historyActionLabel,
} from '../lib/ticket-meta';
import { ACCEPT_ATTR } from '../lib/attachments';
import { positionLabel, timePhrase } from '../lib/contact';
import { renderHtml } from '../lib/sanitize';
import { useAuth } from '../stores/auth';
import { useDateFormat } from '../i18n/format';
import Avatar from '../components/Avatar';
import RichEditor from '../components/RichEditor';
import SlaBadge from '../components/SlaBadge';

export default function TicketDetailPage() {
  const { t } = useTranslation();
  const fmt = useDateFormat();
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { user, has } = useAuth();
  const { data: ticket, isLoading } = useTicket(id);
  const transition = useTransition();
  const assign = useAssign();
  const addMessage = useAddMessage();
  const { data: assignees } = useAssignees();
  const { data: attachments } = useAttachments(id);
  const { data: history } = useHistory(id);
  const updateTicket = useUpdateTicket();
  const updateMessage = useUpdateMessage();
  const addParticipant = useAddParticipant();
  const removeParticipant = useRemoveParticipant();
  const canManageParticipants =
    !!user?.roles.includes('admin') ||
    !!user?.roles.includes('supervisor') ||
    ticket?.assignee?.id === user?.id;
  const { data: participantCandidates } = useParticipantCandidates(
    id,
    canManageParticipants,
  );

  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [assigneeId, setAssigneeId] = useState('');
  const [editorKey, setEditorKey] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [msgDraft, setMsgDraft] = useState('');
  const [participantId, setParticipantId] = useState('');
  const [participantRole, setParticipantRole] = useState<'COLLABORATOR' | 'FOLLOWER'>('COLLABORATOR');
  const [mentionUserIds, setMentionUserIds] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  if (isLoading || !ticket)
    return <div className="text-gray-400">{t('common.loading')}</div>;

  // 前后端滚动升级时旧 API 可能短暂未返回协作字段；详情页保持可用并展示空协作区。
  const participants = ticket.participants ?? [];
  const isStaff =
    user?.roles.includes('admin') ||
    user?.roles.includes('supervisor') ||
    user?.roles.includes('handler');
  const isSupervisorOrAdmin =
    !!user?.roles.includes('admin') || !!user?.roles.includes('supervisor');
  const canAssign =
    has('ticket:assign') && ['NEW', 'REOPENED'].includes(ticket.status);
  const canEditTicket =
    has('ticket:update') && (isStaff || ticket.requester?.id === user?.id);
  const isCollaborator = participants.some(
    (participant) =>
      participant.userId === user?.id && participant.role === 'COLLABORATOR',
  );
  const canReply =
    has('ticket:comment') &&
    (isSupervisorOrAdmin ||
      ticket.requester?.id === user?.id ||
      ticket.assignee?.id === user?.id ||
      isCollaborator);
  const canWriteInternal = isSupervisorOrAdmin || ticket.assignee?.id === user?.id || isCollaborator;

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
  const uploadImg = async (file: File) =>
    attachmentUrl(await uploadAttachment(id, file, undefined, 'inline'));

  const plain = reply.replace(/<[^>]*>/g, '').trim();

  const submitReply = () => {
    if (!plain) return;
    addMessage.mutate(
      { id, arg: { body: reply, isInternal: internal, mentionUserIds } },
      {
        onSuccess: () => {
          setReply('');
          setMentionUserIds([]);
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
        <Link to="/tickets" className="text-sm text-brand-700 hover:underline">
          {t('ticketDetail.back')}
        </Link>
        <span className="font-mono text-xs text-gray-400">
          {ticket.ticketNo}
        </span>
        <span
          className={`inline-block px-2 py-0.5 rounded text-xs ${STATUS_COLOR[ticket.status]}`}
        >
          {statusLabel(t, ticket.status)}
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
            className="rounded-md bg-brand-700 text-white px-3 py-1.5 text-sm hover:bg-brand-800"
          >
            {t('common.save')}
          </button>
          <button
            onClick={() => setEditingTitle(false)}
            className="rounded-md border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm"
          >
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">{ticket.title}</h1>
          {canEditTicket && (
            <button
              onClick={() => {
                setTitleDraft(ticket.title);
                setEditingTitle(true);
              }}
              className="text-xs text-brand-700 hover:underline"
            >
              {t('common.edit')}
            </button>
          )}
        </div>
      )}

      {/* 状态流转 + 指派 */}
      <div className="flex flex-wrap items-center gap-2">
        {ticket.availableActions.map((a) => (
          <button
            key={a}
            disabled={transition.isPending}
            onClick={() => transition.mutate({ id, arg: a })}
            className="rounded-md border border-brand-600 text-brand-700 px-3 py-1.5 text-sm hover:bg-brand-700 hover:text-white disabled:opacity-50"
          >
            {actionLabel(t, a)}
          </button>
        ))}
        {canAssign && (
          <div className="flex items-center gap-2">
            <select
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              aria-label={t('ticketDetail.selectAssignee')}
              className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-sm"
            >
              <option value="">{t('ticketDetail.selectAssignee')}</option>
              {assignees?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
            <button
              disabled={!assigneeId || assign.isPending}
              onClick={() => assign.mutate({ id, arg: { assigneeId } })}
              className="rounded-md bg-brand-700 text-white px-3 py-1.5 text-sm hover:bg-brand-800 disabled:opacity-50"
            >
              {t('ticketDetail.assign')}
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* 中栏 */}
        <div className="lg:col-span-2 space-y-3">
          {/* 会话流：整段往来是一张卡，每条之间只用发丝线分隔。
              逐条独立描边会把一次对话切成一堆互不相干的方块，读起来费劲。 */}
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
            {ticket.messages.map((m, i) => {
              const canEditMsg = m.author.id === user?.id || isSupervisorOrAdmin;
              const editing = editingMsgId === m.id;
              return (
                <article
                  key={m.id}
                  className={`flex gap-3 p-4 ${
                    i > 0 ? 'border-t border-gray-100 dark:border-gray-800' : ''
                  } ${
                    // 内部备注只用淡黄底做区分，不再加边框——它已经在卡内了
                    m.isInternal ? 'bg-amber-50/70 dark:bg-amber-950/20' : ''
                  }`}
                >
                  <Avatar
                    name={m.author.name}
                    email={m.author.email}
                    image={m.author.image}
                    size={36}
                  />
                  <div className="min-w-0 flex-1">
                    <header className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                        {m.author.name}
                      </span>
                      <span className="min-w-0 truncate text-gray-400">
                        {m.author.email}
                      </span>
                      {m.isInternal && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300">
                          {t('ticketDetail.internalTag')}
                        </span>
                      )}
                      {m.mentions.map((mention) => (
                        <span
                          key={mention.user.id}
                          className="rounded bg-brand-50 px-1.5 py-0.5 text-brand-700 dark:bg-brand-950/50 dark:text-brand-300"
                        >
                          @{mention.user.name}
                        </span>
                      ))}
                      <span className="ml-auto shrink-0 text-gray-400">
                        {fmt.dateTime(m.createdAt)}
                      </span>
                      {canEditMsg && !editing && (
                        <button
                          onClick={() => {
                            setMsgDraft(m.body);
                            setEditingMsgId(m.id);
                          }}
                          className="shrink-0 text-brand-700 hover:underline"
                        >
                          {t('common.edit')}
                        </button>
                      )}
                    </header>
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
                            {t('common.cancel')}
                          </button>
                          <button
                            onClick={saveMsg}
                            disabled={updateMessage.isPending}
                            className="rounded-md bg-brand-700 text-white px-3 py-1 text-sm hover:bg-brand-800 disabled:opacity-50"
                          >
                            {t('common.save')}
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
                </article>
              );
            })}
          </div>

          {/* 协作成员与主处理人共用会话框；关注人保持只读，避免“关注”悄悄变成处理责任。 */}
          {canReply ? (
            <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 space-y-2">
              <RichEditor
                key={editorKey}
                placeholder={t('ticketDetail.replyPlaceholder')}
                onChange={setReply}
                onUploadImage={async (file) => {
                  const a = await uploadAttachment(id, file, undefined, 'inline');
                  return attachmentUrl(a);
                }}
              />
              {participants.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-gray-400">{t('ticketDetail.mention')}</span>
                  {participants.map((participant) => {
                    const selected = mentionUserIds.includes(participant.userId);
                    return (
                      <button
                        key={participant.userId}
                        type="button"
                        onClick={() =>
                          setMentionUserIds((ids) =>
                            selected
                              ? ids.filter((item) => item !== participant.userId)
                              : [...ids, participant.userId],
                          )
                        }
                        className={`rounded-full border px-2 py-1 transition-colors ${
                          selected
                            ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-950/50 dark:text-brand-300'
                            : 'border-gray-200 text-gray-500 hover:border-brand-300 dark:border-gray-700 dark:text-gray-400'
                        }`}
                      >
                        @{participant.user.name}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="flex items-center justify-between">
                {canWriteInternal ? (
                  <label className="flex items-center gap-1 text-sm text-gray-500">
                    <input
                      type="checkbox"
                      checked={internal}
                      onChange={(e) => setInternal(e.target.checked)}
                    />
                    {t('ticketDetail.internalCheckbox')}
                  </label>
                ) : (
                  <span />
                )}
                <button
                  disabled={addMessage.isPending || !plain}
                  onClick={submitReply}
                  className="rounded-md bg-brand-700 text-white px-4 py-1.5 text-sm hover:bg-brand-800 disabled:opacity-50"
                >
                  {internal
                    ? t('ticketDetail.addInternalNote')
                    : t('ticketDetail.reply')}
                </button>
              </div>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-gray-300 px-4 py-3 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              {t('ticketDetail.followOnlyHint')}
            </p>
          )}
        </div>

        {/* 右栏 */}
        <div className="space-y-3 text-sm">
          {/* 协作区用两条细轨区分“参与解决”和“只关注”：角色边界直接写在结构里，
              不靠一个抽象的权限说明让人猜。 */}
          <section className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
            <div className="border-b border-gray-100 px-4 py-3 dark:border-gray-800">
              <h2 className="font-medium text-gray-800 dark:text-gray-100">
                {t('ticketDetail.collaboration')}
              </h2>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                {t('ticketDetail.collaborationHint')}
              </p>
            </div>
            <div className="space-y-3 p-4">
              <div>
                <p className="mb-1.5 text-xs font-medium text-gray-500">
                  {t('ticketDetail.primaryAssignee')}
                </p>
                <div className="flex items-center gap-2">
                  <Avatar
                    name={ticket.assignee?.name}
                    email={ticket.assignee?.id}
                    size={24}
                  />
                  <span className="text-sm">
                    {ticket.assignee?.name ?? t('ticketDetail.unassigned')}
                  </span>
                </div>
              </div>
              {(['COLLABORATOR', 'FOLLOWER'] as const).map((role) => {
                const members = participants.filter((item) => item.role === role);
                const collaborative = role === 'COLLABORATOR';
                return (
                  <div key={role} className={`border-l-2 pl-3 ${collaborative ? 'border-brand-500' : 'border-gray-300 dark:border-gray-700'}`}>
                    <p className="mb-1.5 text-xs font-medium text-gray-500">
                      {collaborative
                        ? t('ticketDetail.collaborators')
                        : t('ticketDetail.followers')}
                    </p>
                    {members.length ? (
                      <ul className="space-y-1.5">
                        {members.map((member) => (
                          <li key={member.userId} className="flex items-center gap-2">
                            <Avatar
                              name={member.user.name}
                              email={member.user.email}
                              image={member.user.image}
                              size={22}
                            />
                            <span className="min-w-0 flex-1 truncate text-xs text-gray-700 dark:text-gray-200">
                              {member.user.name}
                            </span>
                            {canManageParticipants && (
                              <button
                                type="button"
                                onClick={() => removeParticipant.mutate({ id, arg: { userId: member.userId } })}
                                className="text-xs text-gray-400 hover:text-red-600"
                              >
                                {t('ticketDetail.removeParticipant')}
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-gray-400">{t('common.empty')}</p>
                    )}
                  </div>
                );
              })}
              {canManageParticipants && (
                <div className="space-y-2 border-t border-gray-100 pt-3 dark:border-gray-800">
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                    <select
                      value={participantId}
                      onChange={(e) => setParticipantId(e.target.value)}
                      aria-label={t('ticketDetail.selectParticipant')}
                      className="min-w-0 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-800"
                    >
                      <option value="">{t('ticketDetail.selectParticipant')}</option>
                      {participantCandidates
                        ?.filter(
                          (candidate) =>
                            candidate.id !== ticket.requester.id &&
                            candidate.id !== ticket.assignee?.id &&
                            !participants.some((member) => member.userId === candidate.id),
                        )
                        .map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.name} · {candidate.email}
                          </option>
                        ))}
                    </select>
                    <select
                      value={participantRole}
                      onChange={(e) => setParticipantRole(e.target.value as 'COLLABORATOR' | 'FOLLOWER')}
                      aria-label={t('ticketDetail.participantRole')}
                      className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-800"
                    >
                      <option value="COLLABORATOR">{t('ticketDetail.collaborator')}</option>
                      <option value="FOLLOWER">{t('ticketDetail.follower')}</option>
                    </select>
                  </div>
                  <button
                    type="button"
                    disabled={!participantId || addParticipant.isPending}
                    onClick={() =>
                      addParticipant.mutate(
                        { id, arg: { userId: participantId, role: participantRole } },
                        { onSuccess: () => setParticipantId('') },
                      )
                    }
                    className="w-full rounded-md border border-brand-600 px-3 py-1.5 text-xs text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:hover:bg-brand-950/40"
                  >
                    {t('ticketDetail.addParticipant')}
                  </button>
                </div>
              )}
            </div>
          </section>
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3">
            <Meta label={t('ticketDetail.metaStatus')}>
              <span
                className={`inline-block px-2 py-0.5 rounded text-xs ${STATUS_COLOR[ticket.status]}`}
              >
                {statusLabel(t, ticket.status)}
              </span>
            </Meta>
            <Meta label={t('ticketDetail.metaPriority')}>
              <span className={PRIORITY_COLOR[ticket.priority]}>
                {priorityLabel(t, ticket.priority)}
              </span>
            </Meta>
            <Meta label={t('ticketDetail.metaRequester')}>
              {ticket.requester?.name}
            </Meta>
            {/* 选填项，没填就不占位——空行只会稀释这块信息的密度。
                处理人要照着这个打电话，所以逐项列出而不是挤成一行摘要 */}
            {ticket.contact && (
              <Meta label={t('ticketDetail.metaContact')}>
                <span className="inline-block space-y-0.5 text-right">
                  <span className="block break-all font-medium">
                    {ticket.contact.phone}
                  </span>
                  {ticket.contact.position && (
                    <span className="block text-xs text-gray-400">
                      {positionLabel(t, ticket.contact.position)}
                    </span>
                  )}
                  <span className="block text-xs text-gray-400">
                    {timePhrase(t, ticket.contact.callTime, 'call')}
                    {' · '}
                    {timePhrase(t, ticket.contact.smsTime, 'sms')}
                  </span>
                  {ticket.contact.emails.map((addr) => (
                    <span
                      key={addr}
                      className="block break-all text-xs text-gray-400"
                    >
                      {addr}
                    </span>
                  ))}
                </span>
              </Meta>
            )}
            <Meta label={t('ticketDetail.metaAssignee')}>
              {ticket.assignee?.name ?? t('ticketDetail.unassigned')}
            </Meta>
            <Meta label={t('ticketDetail.metaQueue')}>
              {ticket.queue?.name ?? t('common.empty')}
            </Meta>
            <Meta label={t('ticketDetail.metaType')}>
              {ticket.type?.name ?? t('common.empty')}
            </Meta>
            <Meta label={t('ticketDetail.metaCategory')}>
              {ticket.category?.name ?? t('common.empty')}
            </Meta>
            {/* IDC 定位信息：填了才显示，没填不占位 */}
            {ticket.datacenter && (
              <Meta label={t('ticketDetail.metaDatacenter')}>
                {ticket.datacenter.name}
              </Meta>
            )}
            {ticket.cluster && (
              <Meta label={t('ticketDetail.metaCluster')}>
                {ticket.cluster.name}
              </Meta>
            )}
            {ticket.serialNumber && (
              <Meta label={t('ticketDetail.metaSerialNumber')}>
                <span className="break-all font-mono text-xs">
                  {ticket.serialNumber}
                </span>
              </Meta>
            )}
            {/* 首次响应：已响应就显示时间，未响应显示时限（超时标红），
                让处理人一眼看到「还欠一个回复」 */}
            <Meta label={t('ticketDetail.metaFirstResponse')}>
              {ticket.firstResponseAt ? (
                fmt.dateTime(ticket.firstResponseAt)
              ) : ticket.firstResponseDueAt ? (
                <span
                  className={
                    new Date(ticket.firstResponseDueAt) < new Date()
                      ? 'text-red-600 dark:text-red-400'
                      : ''
                  }
                >
                  {t('ticketDetail.responseDue', {
                    time: fmt.dateTime(ticket.firstResponseDueAt),
                  })}
                </span>
              ) : (
                t('common.empty')
              )}
            </Meta>
            <Meta label={t('ticketDetail.metaSlaRemaining')}>
              <SlaBadge slaDueAt={ticket.slaDueAt} status={ticket.status} />
              {!ticket.slaDueAt && t('common.empty')}
            </Meta>
            <Meta label={t('ticketDetail.metaSlaDue')}>
              {ticket.slaDueAt
                ? fmt.dateTime(ticket.slaDueAt)
                : t('common.empty')}
            </Meta>
            <Meta label={t('ticketDetail.metaCreatedAt')}>
              {fmt.dateTime(ticket.createdAt)}
            </Meta>
          </div>

          {/* 附件 */}
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-gray-500">
                {t('ticketDetail.attachments')}
              </span>
              {canReply && (
                <>
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="text-brand-700 text-xs hover:underline"
                  >
                    {t('ticketDetail.addAttachment')}
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    multiple
                    hidden
                    accept={ACCEPT_ATTR}
                    onChange={(e) => uploadFiles(e.target.files)}
                  />
                </>
              )}
            </div>
            {attachments?.length ? (
              <ul className="space-y-1">
                {attachments.map((a: Attachment) => (
                  <li key={a.id} className="text-xs">
                    <a
                      href={attachmentUrl(a)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-brand-700 hover:underline break-all"
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
              <p className="text-xs text-gray-400">
                {t('ticketDetail.noAttachments')}
              </p>
            )}
          </div>

          {/* 操作历史 */}
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
            <button
              onClick={() => setShowHistory((s) => !s)}
              aria-expanded={showHistory}
              className="text-gray-500 text-sm w-full text-left"
            >
              {t('ticketDetail.history', { n: history?.length ?? 0 })}{' '}
              {showHistory ? '▲' : '▼'}
            </button>
            {showHistory && (
              <ul className="mt-2 space-y-2">
                {history?.map((h) => (
                  <li key={h.id} className="text-xs text-gray-500 flex gap-2">
                    <span className="text-gray-400 shrink-0">
                      {fmt.dateTime(h.createdAt)}
                    </span>
                    <span>
                      <b>{h.user?.name ?? t('ticketDetail.systemActor')}</b>{' '}
                      {historyActionLabel(t, h.action)}
                      {h.newValue
                        ? `: ${
                            // 这两类记录的 newValue 是状态枚举，翻译后再显示；
                            // 其余（如指派记录里的用户 id）原样透出
                            h.action === 'TRANSITION' || h.action === 'CREATE'
                              ? statusLabel(t, h.newValue)
                              : h.newValue
                          }`
                        : ''}
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

function Meta({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-gray-400">{label}</span>
      <span className="text-gray-700 dark:text-gray-200 text-right">
        {children}
      </span>
    </div>
  );
}
