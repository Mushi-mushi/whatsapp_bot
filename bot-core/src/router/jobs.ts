import type { Handler } from "./router.js";

export class BackgroundJobs {
  private queue: { key: string; run: () => Promise<void> }[] = [];
  private keys = new Set<string>();
  private active?: Promise<void>;
  private accepting = true;

  constructor(private readonly onError: (error: unknown) => void, private readonly capacity = 8) {}

  submit(key: string, run: () => Promise<void>): boolean {
    if (!this.accepting || this.keys.has(key) || this.keys.size >= this.capacity) return false;
    this.keys.add(key);
    this.queue.push({ key, run });
    this.pump();
    return true;
  }

  wrap(handler: Handler): Handler {
    return async (ctx) => {
      if (!this.submit(ctx.msg.chatId, async () => { await handler(ctx); })) {
        await ctx.reply("A background task is already pending here, or the queue is full. Try again shortly.");
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
      this.keys.delete(job.key);
      this.active = undefined;
      this.pump();
    });
  }
}