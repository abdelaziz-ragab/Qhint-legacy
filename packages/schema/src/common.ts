import { z } from 'zod';

export const Id = z.uuid();
export type Id = z.infer<typeof Id>;

/** Short, stable identifiers used inside a document (step ids, screen labels). */
export const LocalId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be 1-64 chars of letters, digits, _ or -');
export type LocalId = z.infer<typeof LocalId>;

export const Timestamp = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof Timestamp>;

/**
 * Axis-aligned box [x1, y1, x2, y2] in the pixel space of the image it refers to
 * (top-left origin, x2 > x1, y2 > y1).
 */
export const BBox = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine((b) => b.every((v) => Number.isFinite(v) && v >= 0), {
    message: 'bbox values must be finite and non-negative',
  })
  .refine(([x1, y1, x2, y2]) => x2 > x1 && y2 > y1, {
    message: 'bbox must satisfy x2 > x1 and y2 > y1',
  });
export type BBox = z.infer<typeof BBox>;

/** True when the box lies fully inside an image of the given pixel size. */
export function bboxWithin(bbox: BBox, width: number, height: number): boolean {
  const [x1, y1, x2, y2] = bbox;
  return x1 >= 0 && y1 >= 0 && x2 <= width && y2 <= height;
}

export const AppKind = z.enum(['web', 'native', 'citrix', 'ide']);
export type AppKind = z.infer<typeof AppKind>;

export const Role = z.enum(['employee', 'admin']);
export type Role = z.infer<typeof Role>;
