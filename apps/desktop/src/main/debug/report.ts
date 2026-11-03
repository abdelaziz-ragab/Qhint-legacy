/**
 * Dev-only debug report: writes the captures and an HTML page that draws the same boxes on each
 * capture, so the on-screen rings can be compared with where the boxes are in the image.
 * Screenshots stay on this machine (app data folder) and are never uploaded.
 */
import { app } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DisplayCapture } from '../capture/capture';
import { describeImage, summarize, type DebugRun } from './debug-rings';

function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}

export async function writeDebugReport(run: DebugRun): Promise<string> {
  const stamp = new Date(run.startedAt).toISOString().replace(/[:.]/g, '-');
  const dir = join(app.getPath('userData'), 'debug-captures', stamp);
  await mkdir(dir, { recursive: true });

  const save = async (kind: string, list: DisplayCapture[]) => {
    for (const c of list) await writeFile(join(dir, `${c.label}-${kind}.jpg`), c.jpeg);
  };
  await save('before', run.captures.before);
  await save('after-raw', run.captures.afterRaw);
  await save('after-guarded', run.captures.afterGuarded);

  const { captures: _captures, ...meta } = run;
  await writeFile(join(dir, 'report.json'), JSON.stringify(meta, null, 2));

  const sections = run.images
    .map((d) => {
      const overlays = d.boxes
        .map((b) => {
          const [x1, y1, x2, y2] = b.bbox;
          const style =
            `left:${(x1 / d.image.width) * 100}%;top:${(y1 / d.image.height) * 100}%;` +
            `width:${((x2 - x1) / d.image.width) * 100}%;height:${((y2 - y1) / d.image.height) * 100}%`;
          return `<div class="box ${b.tone}" style="${style}" title="${b.name}"></div>`;
        })
        .join('');
      const figure = (kind: string, caption: string) => `
        <figure>
          <div class="frame"><img src="${d.label}-${kind}.jpg" />${overlays}</div>
          <figcaption>${esc(caption)}</figcaption>
        </figure>`;
      return `
        <section>
          <h2>${esc(describeImage(d))}</h2>
          <div class="row">
            ${figure('before', 'Before drawing: boxes show where the rings should be')}
            ${figure('after-raw', 'While drawn, without hiding our windows')}
            ${figure('after-guarded', 'While drawn, with capture guard')}
          </div>
        </section>`;
    })
    .join('');

  const html = `<!doctype html>
<html><head><meta charset="utf-8" /><title>Qhint debug report</title>
<style>
  body { font: 13px system-ui, sans-serif; margin: 24px; color: #1d2433; }
  pre { background: #f4f5f7; padding: 12px; white-space: pre-wrap; }
  .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .frame { position: relative; line-height: 0; }
  .frame img { width: 100%; border: 1px solid #ccd; }
  .box { position: absolute; box-sizing: border-box; border: 2px dashed #00b3ff; }
  .box.primary { border-color: #ff2d55; }
  figure { margin: 0; } figcaption { margin-top: 4px; color: #5b6478; }
</style></head>
<body>
  <h1>Qhint debug report</h1>
  <p>Dashed boxes are drawn from the same image-pixel coordinates used for the on-screen rings.
  In the "without hiding" column, a visible amber ring means the OS did not exclude our overlay.</p>
  <pre>${esc(summarize(run))}</pre>
  ${sections}
</body></html>`;
  await writeFile(join(dir, 'report.html'), html);
  return dir;
}
