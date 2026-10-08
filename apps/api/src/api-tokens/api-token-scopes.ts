/** Token 的显式授权范围；请求时仍与账号的实时角色权限取交集。 */
export const API_TOKEN_SCOPES = ['ticket:read', 'ticket:create', 'ticket:comment'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];
