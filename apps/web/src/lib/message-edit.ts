/**
 * 一条会话消息是否允许当前用户编辑：仅作者本人。
 * 只接受作者 id 与当前用户 id 两个入参，角色（admin/supervisor）一律不参与判定——
 * 高岗位也不应看到他人消息的「编辑」入口。
 */
export function canEditMessage(
  authorId: string | undefined,
  currentUserId: string | undefined,
): boolean {
  return !!authorId && !!currentUserId && authorId === currentUserId;
}
