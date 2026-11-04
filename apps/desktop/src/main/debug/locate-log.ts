/**
 * Development builds only: saves what each locate attempt saw and answered, so we can see why a
 * step wasn't found. Files stay in the app data folder on this machine; never uploaded.
 */
import { app } from 'electron';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Step } from '@qhint/schema';
import type { AppPresence, WindowInfo } from '../apps/presence';
import type { GroundingAttempt } from '../runner/grounding';

const runDir = join(
  app.getPath('userData'),
  'debug-locate',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
let count = 0;

export function logLocateAttempt(
  step: Step,
  stepIndex: number,
  attempt: GroundingAttempt,
  timings: Record<string, number> = {},
): void {
  const dir = join(
    runDir,
    `${String(++count).padStart(2, '0')}-${stepIndex < 0 ? 'open-app' : `step${stepIndex + 1}`}`,
  );
  mkdirSync(dir, { recursive: true });
  for (const c of attempt.captures) writeFileSync(join(dir, `${c.label}.jpg`), c.jpeg);
  writeFileSync(
    join(dir, 'attempt.json'),
    JSON.stringify(
      {
        step: { id: step.id, instruction: step.instruction, target: step.target },
        source: attempt.source,
        timings,
        result: attempt.result,
        captures: attempt.captures.map((c) => ({
          label: c.label,
          displayId: c.display.id,
          tile: c.tile,
          image: c.image,
          region: c.region,
          displayBounds: c.display.bounds,
          scaleFactor: c.display.scaleFactor,
        })),
      },
      null,
      2,
    ),
  );
  const r = attempt.result;
  console.log(
    `locate step ${stepIndex + 1}: ${attempt.captures.length} screens -> ${r.kind === 'found' ? `found on ${r.screen} (${r.confidence})` : `none: ${r.reason}`} | ${Object.entries(
      timings,
    )
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}  [${dir}]`,
  );
}

/** Development builds only: what the app check saw and decided (local file + console). */
export function logPresence(
  appName: string,
  presence: AppPresence | null,
  windows: WindowInfo[],
): void {
  mkdirSync(runDir, { recursive: true });
  const top = windows.slice(0, 6).map((w) => `${w.owner} — "${w.title}"`);
  const line = `${new Date().toISOString()} app check "${appName}": ${presence ? presence.state : 'unknown (no permission)'} | front-to-back: ${top.join(' | ')}`;
  appendFileSync(join(runDir, 'presence.log'), `${line}\n`);
  console.log(line);
}

/** Development builds only: guide decisions (clicks, jumps, failures) to the local log + console. */
export function logGuideEvent(line: string): void {
  mkdirSync(runDir, { recursive: true });
  const stamped = `${new Date().toISOString()} ${line}`;
  appendFileSync(join(runDir, 'events.log'), `${stamped}\n`);
  console.log(`guide: ${line}`);
}
