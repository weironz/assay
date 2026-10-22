import { z } from 'zod';
import { getConfig } from '../config';
export const MAX_FILE_SESSION_SECONDS = 7 * 24 * 60 * 60;
export const filePath = z.string().max(4096).refine(p => !p || p.split('/').every(s =>
  !!s && s !== '.' && s !== '..' && s.length <= 255 && !/[\\:*?"<>|\x00-\x1f\x7f]/.test(s) &&
  !/[. ]$/.test(s) && !s.toLowerCase().startsWith('.assay-upload-')));
export const locationSchema = z.object({ share: filePath.refine(s => !!s && !s.includes('/') && !s.endsWith('$')), path: filePath.default('') }).strict();
export const loginSchema = z.object({ password: z.string().min(1).max(512).refine(p => !p.includes('\0')) }).strict();
export const fileCommandSchema = locationSchema.extend({ action: z.enum(['mkdir', 'move', 'delete']), destination: filePath.optional() }).strict()
  .refine(v => !!v.path && (v.action !== 'move' || !!v.destination));
export function enabledModules() {
  const config = getConfig();
  const directory = config.samba.enabled;
  return { directory, files: directory && config.files.enabled };
}
