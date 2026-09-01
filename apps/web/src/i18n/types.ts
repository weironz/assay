import type en from './locales/en';

/**
 * Every locale must be structurally identical to English, so a missing or
 * misspelled key is a compile error rather than a blank label at runtime.
 */
type SameShapeAs<T> = {
  [K in keyof T]: T[K] extends string ? string : SameShapeAs<T[K]>;
};

/**
 * 递归而非只比对两层：contact.time.* 这类分组键也要受同样的约束，
 * 否则漏翻一整组只会在运行时显示成键名。
 */
export type Resource = SameShapeAs<typeof en>;
