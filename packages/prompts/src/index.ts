/** Versioned prompts. Every model call records its prompt id. */
export * from './content';
export * from './locate/types';
export * from './locate/v1';
export * from './locate/computer-use.v1';
export * from './verify/v1';
export * from './ingest/v1';

export const PROMPT_IDS = ['ingest', 'assess', 'locate', 'verify', 'live'] as const;
export type PromptId = (typeof PROMPT_IDS)[number];
