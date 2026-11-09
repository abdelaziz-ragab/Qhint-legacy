/** Provider-neutral request parts (the model gateway maps these to a provider's format). */
export type ContentPart = (
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/jpeg' | 'image/png'; data: Buffer; label?: string }
  /** A whole document: PDF bytes, or plain text. */
  | { type: 'document'; mediaType: 'application/pdf' | 'text/plain'; data: Buffer; title?: string }
) & {
  /**
   * Prompt-cache breakpoint: everything up to and including this part may be cached, so a repeat
   * request with the same beginning (a retry, a second pass) reads it at a fraction of the price.
   */
  cache?: boolean;
};

export interface PromptRequest {
  /** Stable prompt identifier, e.g. "locate.v1" (recorded with every call). */
  promptId: string;
  system: string;
  content: ContentPart[];
  maxTokens: number;
  /** JSON schema the answer must match (structured outputs), when the prompt uses one. */
  outputSchema?: Record<string, unknown>;
  /** Provider-defined tools (e.g. the computer-use toolset), when the prompt uses them. */
  tools?: unknown[];
  effort?: 'low' | 'medium' | 'high';
  /** Longer than the default for big jobs (e.g. a whole video). */
  timeoutMs?: number;
}

export interface ScreenImage {
  /** "screen_1" is always the image under the cursor. */
  label: string;
  width: number;
  height: number;
  jpeg: Buffer;
}
