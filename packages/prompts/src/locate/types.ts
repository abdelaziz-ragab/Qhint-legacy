import type { Step } from '@qhint/schema';
import type { ScreenImage } from '../content';

export interface LocateInput {
  screens: ScreenImage[];
  step: Pick<Step, 'instruction' | 'action' | 'input' | 'app' | 'target'>;
  /** Crop of the target from a previous success or the source video, if available. */
  exemplar?: { jpeg: Buffer; bbox: readonly [number, number, number, number] };
}
