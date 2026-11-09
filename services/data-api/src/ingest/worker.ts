/**
 * Background worker: takes queued ingest jobs one at a time. In development it runs inside
 * data-api; in production the same loop can run in its own service (or behind Cloud Tasks).
 */
import { type IngestDeps, runIngestJob } from './pipeline';

export class IngestWorker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = false;

  constructor(
    private readonly deps: IngestDeps,
    private readonly pollMs = 2000,
  ) {}

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.busy) await new Promise((r) => setTimeout(r, 100));
  }

  /** Process waiting jobs until none are left. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (;;) {
        const job = await this.deps.store.ingest.claim();
        if (!job || this.stopped) break;
        await runIngestJob(this.deps, job);
      }
    } catch {
      this.deps.log?.('ingest worker error');
    } finally {
      this.busy = false;
    }
  }
}
