/** MVP 仅开放 CLI/MCP 所需的低风险工单读写能力。 */
export const API_TOKEN_SCOPES = ['ticket:read', 'ticket:comment'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];
