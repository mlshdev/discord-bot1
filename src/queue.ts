export interface TrackInfo {
  readonly url: string;
  readonly title: string;
  readonly durationSeconds: number | undefined;
  readonly uploader: string | undefined;
}

export interface Track extends TrackInfo {
  readonly uid: string;
  readonly requestedBy: string;
}

export type MoveDirection = -1 | 1;

export class TrackQueue {
  readonly capacity: number;
  #items: Track[] = [];

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get size(): number {
    return this.#items.length;
  }

  get isFull(): boolean {
    return this.#items.length >= this.capacity;
  }

  get items(): readonly Track[] {
    return [...this.#items];
  }

  indexOf(uid: string): number {
    return this.#items.findIndex((track) => track.uid === uid);
  }

  enqueue(track: Track): number {
    if (this.isFull) {
      throw new QueueFullError(this.capacity);
    }
    this.#items.push(track);
    return this.#items.length;
  }

  unshift(track: Track): void {
    this.#items.unshift(track);
  }

  shift(): Track | undefined {
    return this.#items.shift();
  }

  remove(uid: string): Track | undefined {
    const index = this.indexOf(uid);
    if (index === -1) {
      return undefined;
    }
    const [removed] = this.#items.splice(index, 1);
    return removed;
  }

  move(uid: string, direction: MoveDirection): boolean {
    const index = this.indexOf(uid);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= this.#items.length) {
      return false;
    }
    const track = this.#items[index];
    const other = this.#items[target];
    if (track === undefined || other === undefined) {
      return false;
    }
    this.#items[index] = other;
    this.#items[target] = track;
    return true;
  }

  promote(uid: string): Track | undefined {
    const track = this.remove(uid);
    if (track !== undefined) {
      this.#items.unshift(track);
    }
    return track;
  }

  shuffle(random: () => number = Math.random): void {
    for (let i = this.#items.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const a = this.#items[i];
      const b = this.#items[j];
      if (a !== undefined && b !== undefined) {
        this.#items[i] = b;
        this.#items[j] = a;
      }
    }
  }

  clear(): number {
    const count = this.#items.length;
    this.#items = [];
    return count;
  }
}

export class QueueFullError extends Error {
  override readonly name = "QueueFullError";
  readonly capacity: number;

  constructor(capacity: number) {
    super(`Queue is full (${capacity} tracks)`);
    this.capacity = capacity;
  }
}
