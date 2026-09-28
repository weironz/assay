import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';

export const SLA_QUEUE = 'sla';
export type SlaKind = 'response' | 'resolve';
export type SlaJobData = { ticketId: string; kind: SlaKind; dueAt: string };
export const slaReceiptField = (kind: SlaKind) => `sla_${kind}`;

const KINDS: SlaKind[] = ['response', 'resolve'];
const PAGE_SIZE = 100;
const jobIdOf = (ticketId: string, kind: SlaKind) => `${ticketId}-${kind}`;
const recoveryIdOf = (ticketId: string, kind: SlaKind, dueAt: Date, wave: 1 | 2) =>
  `${jobIdOf(ticketId, kind)}-${dueAt.getTime()}${wave === 2 ? '-2' : ''}`;

@Injectable()
export class SlaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SLA');
  private timer?: NodeJS.Timeout;
  private reconciling = false;
  private readonly exhaustedLogAt = new Map<string, number>();
  constructor(
    @InjectQueue(SLA_QUEUE) private readonly queue: Queue<SlaJobData>,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    void this.reconcile().catch((error) => this.logger.error('SLA reconciliation failed', error));
    this.timer = setInterval(() => {
      void this.reconcile().catch((error) => this.logger.error('SLA reconciliation failed', error));
    }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async schedule(ticketId: string, kind: SlaKind, dueAt: Date | null) {
    if (!dueAt) return this.cancel(ticketId, kind);
    const jobId = jobIdOf(ticketId, kind);
    const existing = await this.queue.getJob(jobId);
    const state = existing ? await existing.getState() : null;
    if (existing?.data.dueAt === dueAt.toISOString() && state !== 'failed') return;
    // A replacement job may already be running after the old base job completes.
    if (await this.queue.getJob(recoveryIdOf(ticketId, kind, dueAt, 1))) {
      return this.recover(ticketId, kind, dueAt);
    }
    if (existing) {
      if (state === 'failed' || state === 'active') {
        return this.recover(ticketId, kind, dueAt);
      }
      try { await existing.remove(); }
      catch (error) {
        this.logger.warn(`Could not replace SLA job ${jobId}: ${String(error)}`);
        return;
      }
    }
    await this.addJob(jobId, ticketId, kind, dueAt);
  }

  private async addJob(jobId: string, ticketId: string, kind: SlaKind, dueAt: Date) {
    await this.queue.add('check', { ticketId, kind, dueAt: dueAt.toISOString() }, {
      jobId, delay: Math.max(0, dueAt.getTime() - Date.now()),
      attempts: 5, backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: true, removeOnFail: false,
    });
  }

  /** Two deterministic recovery waves: at most 15 BullMQ attempts per deadline. */
  private async recover(ticketId: string, kind: SlaKind, dueAt: Date) {
    for (const wave of [1, 2] as const) {
      const jobId = recoveryIdOf(ticketId, kind, dueAt, wave);
      const job = await this.queue.getJob(jobId);
      if (!job) {
        await this.addJob(jobId, ticketId, kind, dueAt);
        this.logger.warn(`Scheduled SLA recovery wave ${wave}: ${jobId}`);
        return;
      }
      if (await job.getState() !== 'failed') return;
    }
    const key = recoveryIdOf(ticketId, kind, dueAt, 2);
    const now = Date.now();
    if (now - (this.exhaustedLogAt.get(key) ?? 0) >= 3_600_000) {
      this.logger.error(`SLA recovery exhausted: ${key}; inspect retained failed jobs`);
      this.exhaustedLogAt.set(key, now);
      if (this.exhaustedLogAt.size > 1_000) {
        this.exhaustedLogAt.delete(this.exhaustedLogAt.keys().next().value!);
      }
    }
  }

  async cancel(ticketId: string, kind?: SlaKind) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId }, select: { firstResponseDueAt: true, slaDueAt: true },
    });
    for (const k of kind ? [kind] : KINDS) {
      const base = await this.queue.getJob(jobIdOf(ticketId, k));
      const deadlines = new Set<number>();
      const currentDue = k === 'response' ? ticket?.firstResponseDueAt : ticket?.slaDueAt;
      if (currentDue) deadlines.add(currentDue.getTime());
      if (base?.data.dueAt) deadlines.add(new Date(base.data.dueAt).getTime());
      const jobIds = new Set([jobIdOf(ticketId, k)]);
      for (const dueMs of deadlines) {
        if (!Number.isFinite(dueMs)) continue;
        jobIds.add(recoveryIdOf(ticketId, k, new Date(dueMs), 1));
        jobIds.add(recoveryIdOf(ticketId, k, new Date(dueMs), 2));
      }
      for (const id of jobIds) {
        const job = id === jobIdOf(ticketId, k) ? base : await this.queue.getJob(id);
        if (!job || await job.getState() === 'failed') continue;
        try { await job.remove(); }
        catch (error) {
          if (await job.getState() !== 'active') throw error;
        }
      }
    }
  }

  /** All instances may scan: BullMQ IDs dedupe jobs and DB receipts dedupe effects. */
  async reconcile() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      let cursor: string | undefined;
      do {
        const tickets = await this.prisma.ticket.findMany({
          where: {
            id: cursor ? { gt: cursor } : undefined,
            status: { notIn: ['PENDING', 'RESOLVED', 'CLOSED', 'CANCELLED'] },
            OR: [{ firstResponseDueAt: { not: null }, firstResponseAt: null }, { slaDueAt: { not: null } }],
          },
          select: { id: true, firstResponseDueAt: true, firstResponseAt: true, slaDueAt: true },
          orderBy: { id: 'asc' }, take: PAGE_SIZE,
        });
        if (!tickets.length) break;
        const receipts = await this.prisma.ticketHistory.findMany({
          where: { ticketId: { in: tickets.map((ticket) => ticket.id) }, field: { in: [...KINDS.map(slaReceiptField), 'sla'] } },
          select: { ticketId: true, field: true, oldValue: true, newValue: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        });
        const done = new Set(receipts.map((entry) => `${entry.ticketId}/${entry.field}/${entry.oldValue}`));
        const legacyIds = [...new Set(receipts.filter((entry) => entry.field === 'sla').map((entry) => entry.ticketId))];
        const transitions = legacyIds.length ? await this.prisma.ticketHistory.findMany({
          where: {
            ticketId: { in: legacyIds }, field: 'status',
            OR: [{ oldValue: 'PENDING' }, { newValue: 'REOPENED' }],
          },
          select: { ticketId: true, oldValue: true, newValue: true, createdAt: true },
        }) : [];
        for (const ticket of tickets) {
          const deadlines: [SlaKind, Date | null][] = [
            ['response', ticket.firstResponseAt ? null : ticket.firstResponseDueAt],
            ['resolve', ticket.slaDueAt],
          ];
          for (const [kind, dueAt] of deadlines) {
            if (!dueAt || done.has(`${ticket.id}/${slaReceiptField(kind)}/${dueAt.toISOString()}`)) continue;
            const legacyText = kind === 'response' ? '首次响应超时' : '解决超时';
            const legacyReceipt = receipts.find((entry) => entry.ticketId === ticket.id
              && entry.field === 'sla' && entry.newValue === legacyText && entry.createdAt >= dueAt);
            if (legacyReceipt && !transitions.some((entry) => entry.ticketId === ticket.id
              && entry.createdAt > legacyReceipt.createdAt
              && (entry.oldValue === 'PENDING' || (kind === 'resolve' && entry.newValue === 'REOPENED')))) continue;
            await this.schedule(ticket.id, kind, dueAt);
          }
        }
        cursor = tickets[tickets.length - 1].id;
        if (tickets.length < PAGE_SIZE) break;
      } while (true);
    } finally { this.reconciling = false; }
  }
}
