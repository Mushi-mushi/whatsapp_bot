import type { Handler } from "./router.js";

export class BackgroundJobs {
  private queue: { key: string; run: () => Promise<void> }[] = [];
  private pending = new Map<string, number>();
  private size = 0;
  private active?: Promise<void>;
  private accepting = true;

  constructor(private readonly onError: (error: unknown) => void, private readonly capacity = 8) {}

  // Enqueue `run`. Returns false (rejecting the job) when shutting down, the global
  // queue is full, or this key already has `maxPerKey` jobs pending. The default
  // maxPerKey=1 coalesces duplicate work (e.g. a profile refresh for one user).
  submit(key: string, run: () => Promise<void>, maxPerKey = 1): boolean {
    if (!this.accepting || this.size >= this.capacity) return false;
    if ((this.pending.get(key) ?? 0) >= maxPerKey) return false;
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    this.size += 1;
    this.queue.push({ key, run });
    this.pump();
    return true;
  }

  // Run a handler on the queue, allowing a few requests per chat to line up (FIFO)
  // instead of rejecting a second command while one is still running.
  wrap(handler: Handler, maxPerChat = 3): Handler {
    return async (ctx) => {
      if (!this.submit(ctx.msg.chatId, async () => { await handler(ctx); }, maxPerChat)) {
        await ctx.reply("I'm still working through a few requests here — try again shortly.");
      }
    };
  }

  async stop(): Promise<void> {
    this.accepting = false;
    while (this.active) await this.active;
  }

  private pump(): void {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = Promise.resolve().then(job.run).catch(this.onError).finally(() => {
      const remaining = (this.pending.get(job.key) ?? 1) - 1;
      if (remaining <= 0) this.pending.delete(job.key);
      else this.pending.set(job.key, remaining);
      this.size -= 1;
      this.active = undefined;
      this.pump();
    });
  }
}