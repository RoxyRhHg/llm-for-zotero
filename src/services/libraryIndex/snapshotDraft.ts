/**
 * One unpublished copy-on-write snapshot for a reconciliation batch.
 *
 * Patch planners replace affected immutable collections and retain every
 * untouched identity. The service owns publication and stale-epoch checks.
 */
export class SnapshotDraft<Snapshot> {
  readonly base: Snapshot;
  readonly epoch: number;
  private current: Snapshot;

  constructor(base: Snapshot, epoch: number) {
    this.base = base;
    this.epoch = epoch;
    this.current = base;
  }

  get snapshot(): Snapshot {
    return this.current;
  }

  replace(snapshot: Snapshot | undefined): void {
    if (snapshot) this.current = snapshot;
  }
}
