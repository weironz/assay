import { absUrl } from '../lib/api';

/**
 * 用户头像。没上传头像就退化成姓名首字母色块——会话流里每行都要有个锚点，
 * 空缺会让整列参差不齐。
 */
export default function Avatar({
  name,
  email,
  image,
  size = 32,
}: {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  /** 直径，px */
  size?: number;
}) {
  const box = { width: size, height: size };
  if (image) {
    return (
      <img
        src={absUrl(image)}
        alt=""
        style={box}
        className="shrink-0 rounded-full border border-gray-200 object-cover dark:border-gray-700"
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{ ...box, fontSize: Math.round(size * 0.4) }}
      className="flex shrink-0 items-center justify-center rounded-full bg-brand-600 font-medium text-white"
    >
      {(name || email || '?').trim().slice(0, 1).toUpperCase()}
    </span>
  );
}
