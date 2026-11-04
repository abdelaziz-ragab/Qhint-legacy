import { Procedure } from '@qhint/schema';
import libreofficeInsertTable from '../../../procedures/libreoffice-insert-table.json';

/** Hand-written procedures for development and testing (not tenant content). */
export const SAMPLE_PROCEDURES = {
  'libreoffice-insert-table': Procedure.parse(libreofficeInsertTable),
};
export type SampleId = keyof typeof SAMPLE_PROCEDURES;
