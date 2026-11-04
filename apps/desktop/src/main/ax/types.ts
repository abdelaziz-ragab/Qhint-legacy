/** A user-interface element as reported by the OS accessibility API (via the native helper). */
import { z } from 'zod';

export const AxElement = z.object({
  /** OS role, e.g. AXButton, AXMenuItem, AXCheckBox (macOS) or Button, MenuItem (Windows). */
  role: z.string().max(80),
  subrole: z.string().max(80).optional(),
  title: z.string().max(200).optional(),
  description: z.string().max(200).optional(),
  /** Text of the element's visible label (e.g. "Columns:" for a number field). */
  label: z.string().max(200).optional(),
  /** Current value: checkbox state ("0"/"1"), field contents. Never sent anywhere. */
  value: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
  focused: z.boolean().optional(),
  /** Global DIP rect (top-left of the primary display), same space as Electron's screen API. */
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  depth: z.number().int(),
  /** -1 = menu bar and its open menus; 0.. = windows, front to back. */
  window: z.number().int(),
});
export type AxElement = z.infer<typeof AxElement>;

export const AxElementsResponse = z.object({
  ok: z.literal(true),
  elements: z.array(AxElement).max(5000),
  truncated: z.boolean(),
});
