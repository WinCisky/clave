/**
 * Accounting for sockets that are still connecting.
 *
 * Split out of the Durable Object because it is the piece that decides how long a cold start
 * takes, and it was wrong in two ways that a unit test would have caught immediately.
 *
 * **The cap was four times too high.** `connect()` gives six concurrent connecting sockets, and
 * `WireConn.connect` notes that even a rejected connect spends one while it fails. Dialling twelve
 * at a time and topping up to twenty-four did not buy concurrency, it bought a queue — and a queued
 * dial's deadline runs while it waits, so it failed without ever being attempted and its address
 * was written to the shared `peer_health` table as dead. Over-dialling was actively degrading the
 * peer list for every future session.
 *
 * **The leak guard did not run.** A slot was reclaimed by `setTimeout` and the reclaim never
 * happened, so a dial that never settled held its slot forever, the room available walked down to
 * zero, and dialling stopped with candidates still on the list. The original diagnosis blamed
 * timers not firing inside a Durable Object alarm; that turned out to be false (see
 * `WireConn.connect`). Sweeping expiry from a caller that runs off real awaits is nonetheless the
 * right shape, because it does not depend on the dial ever settling to reclaim its slot — which is
 * the actual failure being guarded against.
 */

export interface DialSlot {
  readonly expiresAt: number;
  /** Idempotent. Safe to call from a settled dial and from a sweep that raced it. */
  release(): void;
}

export class DialSlots {
  #open = new Set<DialSlot>();

  constructor(
    /** Sockets allowed to be connecting at once. A platform limit, not a tuning knob. */
    readonly maxConnecting: number,
    /** Established peers worth holding. Dialling stops early once the pool would overflow. */
    readonly maxPeers: number,
    /** How long a slot may be held by a dial that has not settled. */
    readonly ttlMs: number,
  ) {}

  get inFlight(): number {
    return this.#open.size;
  }

  /**
   * How many dials may start right now.
   *
   * Bounded by both the connecting-socket allowance and the eventual size of the peer pool: there
   * is no point winning a connection there is no room to keep.
   */
  room(established: number): number {
    return Math.max(
      0,
      Math.min(
        this.maxPeers - established - this.#open.size,
        this.maxConnecting - this.#open.size,
      ),
    );
  }

  open(now: number): DialSlot {
    let released = false;
    const slot: DialSlot = {
      expiresAt: now + this.ttlMs,
      release: () => {
        if (released) return;
        released = true;
        this.#open.delete(slot);
      },
    };
    this.#open.add(slot);
    return slot;
  }

  /** Reclaim slots whose dials never settled. Returns how many were taken back. */
  sweep(now: number): number {
    let reclaimed = 0;
    for (const slot of [...this.#open]) {
      if (slot.expiresAt <= now) {
        slot.release();
        reclaimed++;
      }
    }
    return reclaimed;
  }

  /** Drop every slot, for an object going idle. The dials themselves are cancelled by their era. */
  clear(): void {
    for (const slot of [...this.#open]) slot.release();
  }
}
