/**
 * ffmpeg / ffprobe wrappers for processing uploads. Files live in a per-job temp folder that is
 * deleted when the job ends; nothing is kept on the server's disk.
 */
import { spawn } from 'node:child_process';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

function run(cmd: string, args: string[], input?: Buffer, timeoutMs = 600_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (c: Buffer) => out.push(c));
    p.stderr.on('data', (c: Buffer) => {
      if (err.length < 4000) err += c.toString();
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      // stderr can mention file names; keep it out of logs (callers report a code only).
      else reject(new MediaError(`${cmd.split('/').pop()}_exit_${code}`, err));
    });
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

export class MediaError extends Error {
  constructor(
    readonly code: string,
    /** ffmpeg's own message, for local debugging only. */
    readonly detail: string,
  ) {
    super(code);
  }
}

export interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export async function probe(file: string): Promise<VideoInfo> {
  const out = await run(FFPROBE, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  const j = JSON.parse(out.toString()) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[];
  };
  const video = j.streams?.find((s) => s.codec_type === 'video');
  if (!video?.width || !video.height) throw new MediaError('no_video_stream', '');
  return {
    duration: Number(j.format?.duration ?? video.duration ?? 0),
    width: video.width,
    height: video.height,
    hasAudio: !!j.streams?.some((s) => s.codec_type === 'audio'),
  };
}

export const THUMB_W = 96;
export const THUMB_H = 54;

/** Small grayscale frames at `fps`, for spotting changes. */
export async function thumbnails(file: string, fps: number): Promise<Uint8Array[]> {
  const raw = await run(FFMPEG, [
    '-v',
    'error',
    '-i',
    file,
    '-vf',
    `fps=${fps},scale=${THUMB_W}:${THUMB_H}:flags=area,format=gray`,
    '-f',
    'rawvideo',
    '-',
  ]);
  const size = THUMB_W * THUMB_H;
  const frames: Uint8Array[] = [];
  for (let o = 0; o + size <= raw.length; o += size) frames.push(raw.subarray(o, o + size));
  return frames;
}

export interface Frame {
  jpeg: Buffer;
  width: number;
  height: number;
}

/** One frame at time `t`, scaled so its longer side is at most `longSide`. */
export async function frameAt(file: string, t: number, longSide: number): Promise<Frame> {
  const scale = `scale='if(gte(iw,ih),min(${longSide},iw),-2)':'if(gte(iw,ih),-2,min(${longSide},ih))'`;
  const jpeg = await run(FFMPEG, [
    '-v',
    'error',
    '-ss',
    t.toFixed(3),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    scale,
    '-q:v',
    '3',
    '-f',
    'image2pipe',
    '-c:v',
    'mjpeg',
    '-',
  ]);
  const size = jpegSize(jpeg);
  if (!size) throw new MediaError('bad_frame', '');
  return { jpeg, ...size };
}

/** Mono 16 kHz FLAC of part of the soundtrack (what speech recognition wants). */
export function audioFlac(file: string, start = 0, seconds?: number): Promise<Buffer> {
  return run(FFMPEG, [
    '-v',
    'error',
    '-ss',
    start.toFixed(3),
    ...(seconds ? ['-t', seconds.toFixed(3)] : []),
    '-i',
    file,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-f',
    'flac',
    '-',
  ]);
}

/** Crop a JPEG to a rectangle (pixels). */
export async function cropJpeg(
  jpeg: Buffer,
  r: { x: number; y: number; width: number; height: number },
): Promise<Frame> {
  const [x, y, w, h] = [r.x, r.y, r.width, r.height].map((v) => Math.max(0, Math.round(v)));
  const out = await run(
    FFMPEG,
    [
      '-v',
      'error',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      '-i',
      '-',
      '-vf',
      `crop=${w}:${h}:${x}:${y}`,
      '-q:v',
      '3',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      '-',
    ],
    jpeg,
  );
  const size = jpegSize(out);
  if (!size) throw new MediaError('bad_crop', '');
  return { jpeg: out, ...size };
}

/** Width/height from a JPEG's start-of-frame marker. */
export function jpegSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1]!;
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}
