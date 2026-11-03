/** Versioned prompts (ingest, assess, locate, verify, live). Added from Phase 3. */
export const PROMPT_IDS = ['ingest', 'assess', 'locate', 'verify', 'live'] as const;
export type PromptId = (typeof PROMPT_IDS)[number];
