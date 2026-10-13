import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/auth.types';
import { AssetImportInput, AssetImportRow } from './dto';
import { serializable, writeActivity } from './business';

// Explicit alias from supplied inventories and the authenticated NetBox snapshot.
// COP's site naming is independent from NetBox's canonical DCIM slug.
export const SITE_ALIASES: Record<string, string> = {
  'dz-chonburi': 'datazone',
};
export function normalizeImportRow(row: AssetImportRow): AssetImportRow {
  const clean = (v?: string) => v?.trim() || undefined;
  const site = (clean(row.site) || '').toLowerCase();
  return {
    name: row.name.trim(),
    site: SITE_ALIASES[site] || site,
    code: clean(row.code),
    serialNumber: clean(row.serialNumber),
    category: row.category === 'b300' ? 'gpu-server' : clean(row.category),
    manufacturer: clean(row.manufacturer),
    model: clean(row.model),
    rackName: clean(row.rackName),
    rackUnit: clean(row.rackUnit),
    sourceStatus: clean(row.sourceStatus),
    sourceSystem: row.sourceSystem,
    sourceRecordId: row.sourceRecordId.trim(),
  };
}
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
@Injectable()
export class AssetImportService {
  constructor(private readonly db: PrismaService) {}
  private async plan(rows: AssetImportRow[], db: any = this.db) {
    const normalized = rows.map(normalizeImportRow);
    const assets = await db.asset.findMany({
      include: { datacenter: true },
      where: {
        OR: normalized.flatMap((r) => [
          { sourceSystem: r.sourceSystem, sourceRecordId: r.sourceRecordId },
          ...(r.code ? [{ code: r.code }] : []),
          ...(r.serialNumber
            ? [
                {
                  serialNumber: { equals: r.serialNumber, mode: 'insensitive' },
                },
              ]
            : [
                {
                  name: { equals: r.name, mode: 'insensitive' },
                  datacenter: { name: r.site },
                },
              ]),
        ]),
      },
    });
    const sourceKeys = new Set<string>(),
      codes = new Set<string>(),
      serials = new Set<string>(),
      matchedIds = new Set<string>();
    const plan = normalized.map((r, index) => {
      const warnings: string[] = [],
        errors: string[] = [];
      if (!r.name || !r.site || !r.sourceRecordId)
        errors.push('名称、站点和源记录标识不能为空');
      const source = r.sourceSystem + ':' + r.sourceRecordId;
      if (sourceKeys.has(source)) errors.push('本批次源记录标识重复');
      sourceKeys.add(source);
      if (r.code) {
        if (Number(r.code.slice(3)) < 1) errors.push('GS 流水号必须大于零');
        if (codes.has(r.code)) errors.push('本批次资产编号重复');
        codes.add(r.code);
      }
      if (r.serialNumber) {
        const key = r.serialNumber.toUpperCase();
        if (serials.has(key)) errors.push('本批次 SN 重复，请先核对实物');
        serials.add(key);
      } else warnings.push('缺少 SN，请核对实物后补齐');
      const candidates = assets.filter(
        (a: any) =>
          (a.sourceSystem === r.sourceSystem &&
            a.sourceRecordId === r.sourceRecordId) ||
          (r.code && a.code === r.code) ||
          (r.serialNumber &&
            a.serialNumber?.toUpperCase() === r.serialNumber.toUpperCase()) ||
          (!r.serialNumber &&
            a.name.toLowerCase() === r.name.toLowerCase() &&
            a.datacenter?.name === r.site),
      );
      if (candidates.length > 1) errors.push('多个现有资产匹配，不能自动合并');
      const existing = candidates.length === 1 ? candidates[0] : undefined;
      if (existing) {
        if (matchedIds.has(existing.id))
          errors.push('多条源记录匹配同一资产，请先核对重复设备');
        matchedIds.add(existing.id);
      }
      if (
        existing?.serialNumber &&
        r.serialNumber &&
        existing.serialNumber.toUpperCase() !== r.serialNumber.toUpperCase()
      )
        errors.push('源设备 SN 已变化，请核对是否整机换新');
      if (existing?.code && r.code && existing.code !== r.code)
        errors.push('源编号与现有资产编号冲突');
      if (
        existing?.sourceSystem === 'netbox' &&
        r.sourceSystem === 'netbox' &&
        existing.sourceRecordId !== r.sourceRecordId
      )
        errors.push('SN 匹配但 NetBox 对象不同，需人工核对');
      if (!r.code && !existing?.code)
        warnings.push('未发号，导入后保持待核对状态');
      if (!existing) warnings.push('所有权、责任人和实物标签需要核对');
      return {
        index,
        name: r.name,
        site: r.site,
        code: existing?.code || r.code || null,
        action: errors.length ? 'error' : existing ? 'update' : 'create',
        warnings,
        errors,
        existingId: existing?.id || null,
        updatedAt: existing?.updatedAt?.toISOString() || null,
        row: r,
      };
    });
    const fingerprint = digest(plan);
    return {
      fingerprint,
      items: plan,
      created: plan.filter((p: any) => p.action === 'create').length,
      updated: plan.filter((p: any) => p.action === 'update').length,
      errors: plan.filter((p: any) => p.errors.length).length,
    };
  }
  preview(input: AssetImportInput) {
    return this.plan(input.rows);
  }
  async commit(user: AuthUser, input: AssetImportInput) {
    if (!input.fingerprint || !input.idempotencyKey)
      throw new BadRequestException('必须先预览并提供幂等键');
    const idempotencyKey = input.idempotencyKey;
    const requestHash = digest({
      actorId: user.id,
      rows: input.rows.map(normalizeImportRow),
      fingerprint: input.fingerprint,
    });
    const replay = (record: any) => {
      if (record.requestHash !== requestHash)
        throw new ConflictException('导入幂等键已用于其他请求');
      return record.result;
    };
    const old = await this.db.assetImportBatch.findUnique({
      where: { id: idempotencyKey },
    });
    if (old) return replay(old);
    try {
      return await serializable(this.db, async (tx) => {
        const previous = await tx.assetImportBatch.findUnique({
          where: { id: idempotencyKey },
        });
        if (previous) return replay(previous);
        const plan = await this.plan(input.rows, tx);
        if (plan.fingerprint !== input.fingerprint)
          throw new ConflictException('数据在预览后发生变化，请重新预览');
        if (plan.errors)
          throw new BadRequestException('预览存在错误，请修正后再导入');
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(73020261012::bigint)`;
        const ids: string[] = [];
        for (const item of plan.items) {
          const r = item.row;
          const before = item.existingId
            ? await tx.asset.findUnique({ where: { id: item.existingId } })
            : null;
          const site = await tx.datacenter.upsert({
            where: { name: r.site },
            update: {},
            create: { name: r.site },
          });
          const retainNetbox =
            before?.sourceSystem === 'netbox' && r.sourceSystem === 'excel';
          // Missing Excel columns are not an instruction to erase known DCIM metadata.
          // Explicit field clearing belongs to the audited asset edit endpoint.
          const data = {
            name: r.name,
            category: r.category ?? before?.category ?? null,
            manufacturer: r.manufacturer ?? before?.manufacturer ?? null,
            model: r.model ?? before?.model ?? null,
            serialNumber: r.serialNumber ?? before?.serialNumber ?? null,
            datacenterId: site.id,
            rackName: r.rackName ?? before?.rackName ?? null,
            rackUnit: r.rackUnit ?? before?.rackUnit ?? null,
            sourceStatus: r.sourceStatus ?? before?.sourceStatus ?? null,
            ...(retainNetbox
              ? {}
              : {
                  sourceSystem: r.sourceSystem,
                  sourceRecordId: r.sourceRecordId,
                  sourceUrl:
                    r.sourceSystem === 'netbox'
                      ? 'https://netbox.cloudcele.com/dcim/devices/' +
                        encodeURIComponent(r.sourceRecordId) +
                        '/'
                      : null,
                  lastSyncedAt: new Date(),
                }),
            code: before?.code || r.code || null,
          };
          if (data.code) {
            const n = Number(data.code.slice(3));
            await tx.$executeRaw`SELECT setval('asset_number_sequence',GREATEST((SELECT last_value FROM asset_number_sequence),${n}::bigint),true)`;
          }
          const asset = before
            ? await tx.asset.update({ where: { id: before.id }, data })
            : await tx.asset.create({
                data: {
                  ...data,
                  status: 'PENDING_REGISTRATION',
                  ownership: 'UNCONFIRMED',
                  labelVerified: false,
                },
              });
          await writeActivity(
            tx,
            user,
            'asset',
            asset.id,
            before ? 'IMPORT_UPDATE' : 'IMPORT_CREATE',
            before,
            {
              ...asset,
              importSource: {
                system: r.sourceSystem,
                recordId: r.sourceRecordId,
              },
            },
          );
          ids.push(asset.id);
        }
        const result = { created: plan.created, updated: plan.updated, ids };
        await tx.assetImportBatch.create({
          data: {
            id: idempotencyKey,
            actorId: user.id,
            actorName: user.name,
            requestHash,
            result,
          },
        });
        return result;
      });
    } catch (error: any) {
      if (error.code === 'P2002') {
        const committed = await this.db.assetImportBatch.findUnique({
          where: { id: idempotencyKey },
        });
        if (committed) return replay(committed);
        throw new ConflictException('资产在导入期间发生变化，请重新预览');
      }
      throw error;
    }
  }
  async netbox() {
    const base = (
      process.env.NETBOX_API_BASE_URL || 'https://netbox.cloudcele.com'
    ).replace(/\/$/, '');
    const url = new URL(base);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'netbox.cloudcele.com' ||
      url.username ||
      url.password ||
      url.pathname !== '/'
    )
      throw new ServiceUnavailableException(
        'NetBox 地址配置不符合受控 HTTPS 来源',
      );
    const token = process.env.NETBOX_API_TOKEN;
    if (!token)
      throw new ServiceUnavailableException(
        'NetBox 只读 API 密钥尚未配置；可先使用 Excel 导入',
      );
    const records: AssetImportRow[] = [];
    let next = base + '/api/dcim/devices/?limit=200';
    while (next) {
      const page = new URL(next);
      if (
        page.origin !== url.origin ||
        !page.pathname.startsWith('/api/dcim/devices/')
      )
        throw new ServiceUnavailableException('NetBox 返回了不允许的分页地址');
      let response: Response;
      try {
        response = await fetch(next, {
          headers: { Authorization: 'Token ' + token },
          signal: AbortSignal.timeout(20000),
          redirect: 'error',
        });
      } catch {
        throw new ServiceUnavailableException(
          'NetBox 连接失败，请检查代理、证书和服务状态',
        );
      }
      if (!response.ok)
        throw new ServiceUnavailableException(
          'NetBox 只读请求失败（HTTP ' + response.status + '）',
        );
      const data: any = await response.json();
      if (!Array.isArray(data.results))
        throw new ServiceUnavailableException('NetBox 响应格式不正确');
      for (const device of data.results)
        records.push(
          normalizeImportRow({
            name: String(device.name || ''),
            site: device.site?.slug || '',
            sourceSystem: 'netbox',
            sourceRecordId: String(device.id),
            code: device.asset_tag || undefined,
            serialNumber: device.serial || undefined,
            category: device.role?.slug,
            manufacturer: device.device_type?.manufacturer?.name,
            model: device.device_type?.model,
            rackName: device.rack?.name,
            rackUnit:
              device.position == null ? undefined : String(device.position),
            sourceStatus: device.status?.value,
          }),
        );
      if (records.length > 500)
        throw new BadRequestException('NetBox 超过 500 台，请分站点导出后导入');
      next = data.next || '';
    }
    return { rows: records };
  }
}
