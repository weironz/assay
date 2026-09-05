import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type { CreateApiTokenDto } from './api-tokens.dto';
import { type ApiTokenScope } from './api-token-scopes';

@Injectable()
export class ApiTokensService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthUser) {
    const tokens = await this.prisma.apiToken.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, prefix: true, scopes: true, expiresAt: true,
        lastUsedAt: true, revokedAt: true, createdAt: true,
      },
    });
    const now = new Date();
    return tokens.map((token) => ({
      ...token,
      status: token.revokedAt ? 'REVOKED' : token.expiresAt && token.expiresAt <= now ? 'EXPIRED' : 'ACTIVE',
    }));
  }

  async create(user: AuthUser, dto: CreateApiTokenDto) {
    const scopes = this.normalizeScopes(dto.scopes);
    return this.createSecret(user.id, dto.name.trim(), scopes, dto.expiresInDays);
  }

  async rotate(user: AuthUser, id: string) {
    const current = await this.prisma.apiToken.findFirst({ where: { id, userId: user.id } });
    if (!current) throw new NotFoundException('API Token 不存在');
    if (current.revokedAt) throw new BadRequestException('已吊销的 Token 无法轮换');
    await this.prisma.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });
    const remainingDays = current.expiresAt
      ? Math.max(1, Math.ceil((current.expiresAt.getTime() - Date.now()) / 86_400_000))
      : undefined;
    return this.createSecret(user.id, `${current.name}（已轮换）`, current.scopes as ApiTokenScope[], remainingDays);
  }

  async revoke(user: AuthUser, id: string) {
    const result = await this.prisma.apiToken.updateMany({
      where: { id, userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!result.count) throw new NotFoundException('API Token 不存在或已吊销');
    return { revoked: true };
  }

  async findActiveBySecret(secret: string) {
    if (!secret.startsWith('ast_') || secret.length < 24) return null;
    const token = await this.prisma.apiToken.findUnique({
      where: { tokenHash: this.hash(secret) },
      include: { user: { include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } } } },
    });
    if (!token || token.revokedAt || (token.expiresAt && token.expiresAt <= new Date())) return null;
    await this.prisma.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } });
    return token;
  }

  private async createSecret(userId: string, name: string, scopes: ApiTokenScope[], expiresInDays?: number) {
    const secret = `ast_${randomBytes(32).toString('base64url')}`;
    const token = await this.prisma.apiToken.create({
      data: {
        userId, name, tokenHash: this.hash(secret), prefix: `${secret.slice(0, 12)}…`, scopes,
        expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null,
      },
      select: { id: true, name: true, prefix: true, scopes: true, expiresAt: true, createdAt: true },
    });
    return { ...token, token: secret };
  }

  private normalizeScopes(scopes: ApiTokenScope[]) {
    const unique = [...new Set(scopes)];
    if (unique.includes('ticket:comment') && !unique.includes('ticket:read')) unique.unshift('ticket:read');
    return unique;
  }

  private hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
}
