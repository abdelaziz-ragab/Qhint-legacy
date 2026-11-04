/** Provider-neutral request parts (the model gateway maps these to a provider's format). */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/jpeg' | 'image/png'; data: Buffer; label?: string };

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
}

export interface ScreenImage {
  /** "screen_1" is always the image under the cursor. */
  label: string;
  width: number;
  height: number;
  jpeg: Buffer;
}
