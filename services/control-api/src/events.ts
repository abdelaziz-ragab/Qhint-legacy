/**
 * Operator analytics sink. Events are validated against the strict OperatorEvent whitelist before
 * they get here. The default sink is Postgres (control schema, $0); BigQuery is a drop-in sink
 * for when volume justifies it.
 */
import { BigQuery } from '@google-cloud/bigquery';
import type { OperatorEvent } from '@qhint/schema';
import type { ControlStore } from './control-store';

export interface EventSink {
  write(events: OperatorEvent[]): Promise<void>;
}

export class PgEventSink implements EventSink {
  constructor(private readonly store: ControlStore) {}
  write(events: OperatorEvent[]) {
    return this.store.insertEvents(events);
  }
}

export class BigQueryEventSink implements EventSink {
  private readonly bq = new BigQuery();
  constructor(
    private readonly dataset: string,
    private readonly table: string,
  ) {}
  async write(events: OperatorEvent[]) {
    if (events.length === 0) return;
    await this.bq
      .dataset(this.dataset)
      .table(this.table)
      .insert(events.map((e) => ({ ...e, received_at: new Date().toISOString() })));
  }
}
