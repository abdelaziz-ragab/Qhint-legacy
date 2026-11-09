import type { GuideJob, GuideStatus } from '../../shared/guides';

export const STATUS_LABEL: Record<GuideStatus, string> = {
  draft: 'Draft',
  in_review: 'In review',
  published: 'Published',
};

export const STAGE_LABEL: Record<GuideJob['stage'], string> = {
  queued: 'Waiting to start…',
  reading: 'Reading the file…',
  frames: 'Finding the key moments…',
  transcribing: 'Listening to the narration…',
  writing: 'Writing the steps…',
  images: 'Saving pictures of each button…',
  saving: 'Saving the guide…',
  done: 'Ready',
  failed: 'Failed',
};

const ERRORS: Record<string, string> = {
  no_procedure: "We couldn't find a step-by-step task in this file.",
  too_long: 'The video is longer than 30 minutes. Trim it and try again.',
  too_large: 'The file is too large.',
  unsupported_type: "This kind of file isn't supported yet.",
  bad_media: "The video couldn't be read. Try exporting it again as MP4.",
  source_missing: 'The uploaded file is missing. Please upload it again.',
  invalid_output: "The AI's answer wasn't usable. Please try again.",
  refusal: 'The AI declined to process this file.',
  provider_error: 'The AI service was unavailable. Please try again later.',
  too_many_attempts: 'It failed several times. Please try again later.',
  upload_failed: 'The upload failed. Check your connection and try again.',
  empty_file: 'The file is empty.',
  not_a_file: "That isn't a file.",
  signed_out: 'You were signed out. Please sign in again.',
  screen_permission: 'Qhint needs permission to see your screen (System Settings → Privacy).',
  sign_in_required: 'Please sign in first.',
};

export function errorText(code: string | null | undefined): string {
  if (!code) return 'Something went wrong.';
  return ERRORS[code] ?? `Something went wrong (${code}).`;
}

/** Languages Qhint can listen to (narration, BCP-47) and write guides in. */
export const LANGUAGES: { name: string; speech: string }[] = [
  { name: 'English', speech: 'en-US' },
  { name: 'Arabic', speech: 'ar-EG' },
  { name: 'French', speech: 'fr-FR' },
  { name: 'German', speech: 'de-DE' },
  { name: 'Spanish', speech: 'es-ES' },
  { name: 'Italian', speech: 'it-IT' },
  { name: 'Portuguese', speech: 'pt-BR' },
  { name: 'Dutch', speech: 'nl-NL' },
  { name: 'Hindi', speech: 'hi-IN' },
];

export const SOURCE_ICON: Record<string, string> = {
  video: '🎬',
  doc: '📄',
  recording: '⏺',
  generated: '✨',
};

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
