import type { OperatorEvent } from '@qhint/schema';
import type { InternalCaller } from '@qhint/server-kit';

/**
 * Batches content-free operator events and sends them to control-api. Analytics are best-effort:
 * if delivery fails the batch is dropped (only a count is logged), never retried with content.
 */
export class HttpEventEmitter {
  private queue: OperatorEvent[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly controlApiUrl: string,
    private readonly caller: InternalCaller,
    private readonly opts: { maxBatch?: number; flushMs?: number } = {},
  ) {}

  emit = (event: OperatorEvent): void => {
    this.queue.push(event);
    if (this.queue.length >= (this.opts.maxBatch ?? 50)) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), this.opts.flushMs ?? 2000);
  };

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.queue.splice(0);
    if (batch.length === 0) return;
    try {
      const res = await fetch(`${this.controlApiUrl}/internal/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(await this.caller.headers(this.controlApiUrl)),
        },
        body: JSON.stringify({ events: batch }),
      });
      if (!res.ok) console.warn(`operator events dropped: ${batch.length} (status ${res.status})`);
    } catch {
      console.warn(`operator events dropped: ${batch.length} (unreachable)`);
    }
  }
}
