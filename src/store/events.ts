/**
 * In-process event bus feeding the SSE endpoint.
 *
 * Small on purpose: the dashboard needs a snapshot plus a stream, and an
 * unbounded buffer would turn a slow browser into an OOM on the engine. Ring
 * buffer for replay, live subscribers for the rest.
 */
export type EventType = "snapshot" | "tick" | "quote" | "fill" | "kill" | "error" | "status" | "mode" | "proof";

export interface DeskEvent {
  type: EventType;
  ts: number;
  data: unknown;
}

export class EventBus {
  private readonly ring: DeskEvent[] = [];
  private readonly subs = new Set<(e: DeskEvent) => void>();
  private readonly maxRing: number;

  constructor(maxRing = 500) {
    this.maxRing = maxRing;
  }

  emit(type: EventType, data: unknown): DeskEvent {
    const e: DeskEvent = { type, ts: Date.now(), data };
    this.ring.push(e);
    if (this.ring.length > this.maxRing) this.ring.shift();
    for (const fn of this.subs) {
      try {
        fn(e);
      } catch {
        // A broken subscriber must not break the engine.
      }
    }
    return e;
  }

  subscribe(fn: (e: DeskEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  recent(n = 50): DeskEvent[] {
    return this.ring.slice(-n);
  }

  get subscriberCount(): number {
    return this.subs.size;
  }
}
