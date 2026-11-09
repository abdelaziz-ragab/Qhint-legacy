/**
 * Speech to text for narrated recordings, behind one interface so the service can be swapped.
 * Google Cloud Speech-to-Text is the default (it runs inside our Google Cloud project, next to
 * the rest of the backend). Audio is sent in chunks for recognition only and is never stored.
 */
import type { TranscriptSegment } from '@qhint/prompts';
import { GoogleAuth } from 'google-auth-library';

/** A piece of the soundtrack: where it starts in the video, and its audio (mono 16 kHz FLAC). */
export interface AudioChunk {
  start: number;
  flac: Buffer;
}

export interface Transcriber {
  readonly name: string;
  /** Empty when nothing was said. Times are seconds from the start of the video. */
  transcribe(chunks: AudioChunk[], language: string): Promise<TranscriptSegment[]>;
}

/** Longest chunk the speech service accepts inline (its limit is one minute). */
export const CHUNK_SECONDS = 55;

/** No speech recognition configured: every video is treated as having no narration. */
export class NoTranscriber implements Transcriber {
  readonly name = 'none';
  async transcribe(): Promise<TranscriptSegment[]> {
    return [];
  }
}

/** Tests: always answers with the given transcript. */
export class FixedTranscriber implements Transcriber {
  readonly name = 'fixed';
  constructor(private readonly segments: TranscriptSegment[]) {}
  async transcribe(): Promise<TranscriptSegment[]> {
    return this.segments;
  }
}

export class TranscribeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const API = 'https://speech.googleapis.com/v1';
const PARALLEL = 4;

const seconds = (d: string | undefined) => (d ? Number(d.replace(/s$/, '')) || 0 : 0);

interface RecognizeResponse {
  results?: {
    alternatives?: { transcript?: string; words?: { startTime?: string; endTime?: string }[] }[];
    resultEndTime?: string;
  }[];
}

/**
 * Google Cloud Speech-to-Text. Each chunk (under a minute) is recognised directly, a few at a
 * time; audio is sent inline and never stored.
 */
export class GoogleSpeechTranscriber implements Transcriber {
  readonly name = 'google-speech';
  private readonly auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  /** Whether the better "latest_long" model works for the language (not all have it). */
  private readonly modelFor = new Map<string, boolean>();

  constructor(private readonly opts: { projectId?: string } = {}) {}

  async transcribe(chunks: AudioChunk[], language: string): Promise<TranscriptSegment[]> {
    const results: TranscriptSegment[][] = new Array(chunks.length);
    let next = 0;
    const work = async () => {
      while (next < chunks.length) {
        const i = next++;
        const c = chunks[i]!;
        results[i] = toSegments(await this.recognize(c.flac, language), c.start);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, work));
    return results.flat();
  }

  private async recognize(flac: Buffer, language: string): Promise<RecognizeResponse> {
    const config = {
      encoding: 'FLAC',
      sampleRateHertz: 16000,
      languageCode: language,
      enableAutomaticPunctuation: true,
      enableWordTimeOffsets: true,
    };
    const audio = { content: flac.toString('base64') };
    if (this.modelFor.get(language) !== false) {
      try {
        const r = await this.post<RecognizeResponse>('/speech:recognize', {
          config: { ...config, model: 'latest_long' },
          audio,
        });
        this.modelFor.set(language, true);
        return r;
      } catch (e) {
        if (!(e instanceof TranscribeError && e.code === 'speech_400')) throw e;
        this.modelFor.set(language, false);
      }
    }
    return this.post<RecognizeResponse>('/speech:recognize', { config, audio });
  }

  private async headers(): Promise<Record<string, string>> {
    const client = await this.auth.getClient();
    const h = await client.getRequestHeaders();
    const out: Record<string, string> = { 'content-type': 'application/json' };
    h.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    // Bill our project, whatever default project the credentials carry.
    const project = this.opts.projectId ?? (await this.auth.getProjectId().catch(() => undefined));
    if (project) out['x-goog-user-project'] = project;
    return out;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new TranscribeError(`speech_${res.status}`);
    return (await res.json()) as T;
  }
}

/** One segment per recognised phrase, timed from its first word. */
export function toSegments(r: RecognizeResponse, offset = 0): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let prevEnd = 0;
  for (const res of r.results ?? []) {
    const alt = res.alternatives?.[0];
    const text = alt?.transcript?.trim();
    if (!text) continue;
    const end = seconds(res.resultEndTime);
    const start = alt?.words?.length ? seconds(alt.words[0]!.startTime) : prevEnd;
    out.push({ start: offset + start, end: offset + Math.max(end, start), text });
    prevEnd = end;
  }
  return out;
}
