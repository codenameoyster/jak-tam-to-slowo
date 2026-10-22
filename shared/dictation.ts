import type { Language } from './types';

export type DictationLanguage = Language | 'auto';

export const DICTATION_MAX_BYTES = 2 * 1024 * 1024;
export const DICTATION_TYPES = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm', 'audio/mp4'];
