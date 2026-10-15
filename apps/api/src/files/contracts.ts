import { z } from 'zod';
export const filePath = z.string().max(4096).refine(p => !p || p.split('/').every(s =>
  !!s && s !== '.' && s !== '..' && s.length <= 255 && !/[\\:*?"<>|\x00-\x1f\x7f]/.test(s) &&
  !/[. ]$/.test(s) && !s.toLowerCase().startsWith('.assay-upload-')));
export const locationSchema = z.object({ share: filePath.refine(s => !!s && !s.includes('/') && !s.endsWith('$')), path: filePath.default('') }).strict();
export const loginSchema = z.object({ password: z.string().min(1).max(512).refine(p => !p.includes('\0')) }).strict();
export const fileCommandSchema = locationSchema.extend({ action: z.enum(['mkdir', 'move', 'delete']), destination: filePath.optional() }).strict()
  .refine(v => !!v.path && (v.action !== 'move' || !!v.destination));
export function enabledModules() {
  const directory = process.env.SAMBA_ENABLED === 'true';
  return { directory, files: directory && process.env.FILES_ENABLED === 'true' };
}
