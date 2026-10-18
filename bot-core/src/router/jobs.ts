import type { Handler } from "./router.js";
import type { BackgroundJobFailure, BackgroundJobKind, BackgroundJobsSnapshot } from "../../../shared/api.js";

export class BackgroundJobs {
  private queue: { key: string; run: () => Promise<void>; kind: BackgroundJobKind; queuedAt: number }[] = [];
  private pending = new Map<string, number>();
  private size = 0;
  private active?: Promise<void>;
  private accepting = true;
  private running: BackgroundJobsSnapshot["running"] = null;
  private completed = 0;
  private failed = 0;
  private rejected = { capacity: 0, duplicate: 0, stopping: 0 };
  private failures: BackgroundJobFailure[] = [];

  constructor(private readonly onError: (error: unknown) => void, private readonly capacity = 8) {}

  // Enqueue `run`. Returns false (rejecting the job) when shutting down, the global
  // queue is full, or this key already has `maxPerKey` jobs pending. The default
  // maxPerKey=1 coalesces duplicate work (e.g. a profile refresh for one user).
  submit(key: string, run: () => Promise<void>, maxPerKey = 1, kind: BackgroundJobKind = "command"): boolean {
    if (!this.accepting) { this.rejected.stopping += 1; return false; }
    if (this.size >= this.capacity) { this.rejected.capacity += 1; return false; }
    if ((this.pending.get(key) ?? 0) >= maxPerKey) { this.rejected.duplicate += 1; return false; }
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    this.size += 1;
    this.queue.push({ key, run, kind, queuedAt: Date.now() });
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

  snapshot(): BackgroundJobsSnapshot {
    return {
      capacity: this.capacity, accepting: this.accepting,
      running: this.running ? { ...this.running } : null,
      queued: this.queue.length, oldestQueuedAt: this.queue[0]?.queuedAt ?? null,
      completed: this.completed, failed: this.failed, rejected: { ...this.rejected },
      recentFailures: this.failures.map((failure) => ({ ...failure })),
    };
  }

  private pump(): void {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    const startedAt = Date.now();
    this.running = { kind: job.kind, startedAt };
    this.active = Promise.resolve().then(job.run).then(() => { this.completed += 1; }).catch((error: unknown) => {
      this.failed += 1;
      this.failures.unshift({ id: this.failed, kind: job.kind, startedAt, failedAt: Date.now() });
      this.failures.length = Math.min(this.failures.length, 20);
      this.onError(error);
    }).finally(() => {
      const remaining = (this.pending.get(job.key) ?? 1) - 1;
      if (remaining <= 0) this.pending.delete(job.key);
      else this.pending.set(job.key, remaining);
      this.size -= 1;
      this.active = undefined;
      this.running = null;
      this.pump();
    });
  }
}