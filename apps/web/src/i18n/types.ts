import type en from './locales/en';

/**
 * Every locale must be structurally identical to English, so a missing or
 * misspelled key is a compile error rather than a blank label at runtime.
 */
export type Resource = {
  [S in keyof typeof en]: Record<keyof (typeof en)[S], string>;
};
