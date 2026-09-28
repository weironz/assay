import { ConflictException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

/** Friendly precheck; the database trigger is the race-safe final guard. */
export async function assertCanLoseActiveAdmin(prisma: PrismaClient, userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true, roles: { select: { role: { select: { name: true } } } } },
  });
  if (user?.status !== 'ACTIVE' || !user.roles.some((r) => r.role.name === 'admin')) return;
  const activeAdmins = await prisma.user.count({
    where: { status: 'ACTIVE', roles: { some: { role: { name: 'admin' } } } },
  });
  if (activeAdmins <= 1) throw new ConflictException('不能移除或停用最后一位在职管理员');
}
