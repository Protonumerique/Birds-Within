/**
 * The single authority for "what time is it in the scene".
 *
 * Every propagation and every trail sample must come from here. Mixing this with
 * `new Date()` elsewhere is how a scrubbed timeline silently desynchronises from
 * what is drawn.
 */
export class Clock {
  /** Scene time, independent of wall-clock once scrubbed or rate-changed. */
  private sceneMs: number;
  private lastWallMs: number;
  private rate = 1;
  private paused = false;
  private discontinuities = 0;

  constructor(start: Date = new Date()) {
    this.sceneMs = start.getTime();
    this.lastWallMs = performance.now();
  }

  /** Advance scene time by the real time elapsed since the last call. */
  tick(): void {
    const now = performance.now();
    const elapsed = now - this.lastWallMs;
    this.lastWallMs = now;
    if (!this.paused) this.sceneMs += elapsed * this.rate;
  }

  get date(): Date {
    return new Date(this.sceneMs);
  }

  /** Scene time in ms since 1970, without allocating a Date every frame. */
  get ms(): number {
    return this.sceneMs;
  }

  /**
   * Increments whenever scene time jumps or changes speed. Anything that buffers
   * ahead in scene time - the sky stream does - must drop that buffer when this
   * changes, or it will blend straight across the jump.
   */
  get generation(): number {
    return this.discontinuities;
  }

  get timeRate(): number {
    return this.rate;
  }

  set timeRate(r: number) {
    if (r === this.rate) return;
    this.rate = r;
    this.discontinuities++;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  togglePause(): void {
    this.paused = !this.paused;
  }

  /** Jump by a number of seconds of scene time. */
  nudge(seconds: number): void {
    this.sceneMs += seconds * 1000;
    this.discontinuities++;
  }

  resetToNow(): void {
    this.sceneMs = Date.now();
    this.discontinuities++;
  }
}
