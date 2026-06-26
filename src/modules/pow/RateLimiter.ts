export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  private timer: ReturnType<typeof setInterval>;

  constructor(private maxRequests: number, private windowMs: number) {
    this.timer = setInterval(() => this.cleanup(), 60000);
    this.timer.unref();
  }

  isAllowed(key: string): boolean {
    const now = Date.now();
    let entry = this.buckets.get(key);

    if (!entry || entry.resetAt <= now) {
      this.buckets.set(key, { count: 0, resetAt: now + this.windowMs });
      entry = this.buckets.get(key);
    }

    if (entry.count >= this.maxRequests) return false;
    entry.count++;
    return true;
  }

  destroy() {
    clearInterval(this.timer);
    this.buckets.clear();
  }

  private cleanup() {
    const now = Date.now();
    for (const [k, v] of this.buckets) {
      if (v.resetAt <= now) this.buckets.delete(k);
    }
  }
}
