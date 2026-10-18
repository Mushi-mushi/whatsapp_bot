import type { Handler } from "./router.js";
import { randomUUID } from "node:crypto";
import type { BackgroundJob, BackgroundJobFailure, BackgroundJobKind, BackgroundJobsSnapshot } from "../../../shared/api.js";

export interface JobControl {
  signal: AbortSignal;
  setStage: (stage: string) => void;
}

interface QueuedJob {
  key: string;
  run: (control: JobControl) => Promise<void>;
  controller: AbortController;
  details: BackgroundJob;
  onCancel?: () => void;
}

export class JobCancelledError extends Error {
  constructor() {
    super("Job cancelled by the administrator.");
    this.name = "JobCancelledError";
  }
}

export class BackgroundJobs {
  private queue: QueuedJob[] = [];
  private activeJob?: QueuedJob;
  private pending = new Map<string, number>();
  private size = 0;
  private active?: Promise<void>;
  private accepting = true;
  private running: BackgroundJobsSnapshot["running"] = null;
  private completed = 0;
  private cancelled = 0;
  private failed = 0;
  private rejected = { capacity: 0, duplicate: 0, stopping: 0 };
  private failures: BackgroundJobFailure[] = [];

  constructor(private readonly onError: (error: unknown) => void, private readonly capacity = 8) {}

  // Enqueue `run`. Returns false (rejecting the job) when shutting down, the global
  // queue is full, or this key already has `maxPerKey` jobs pending. The default
  // maxPerKey=1 coalesces duplicate work (e.g. a profile refresh for one user).
  submit(key: string, run: (control: JobControl) => Promise<void>, maxPerKey = 1, kind: BackgroundJobKind = "command",
    options: { description?: string; cancellable?: boolean; onCancel?: () => void } = {}): boolean {
    if (!this.accepting) { this.rejected.stopping += 1; return false; }
    if (this.size >= this.capacity) { this.rejected.capacity += 1; return false; }
    if ((this.pending.get(key) ?? 0) >= maxPerKey) { this.rejected.duplicate += 1; return false; }
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    this.size += 1;
    this.queue.push({
      key, run, controller: new AbortController(), onCancel: options.onCancel,
      details: {
        id: randomUUID(), kind, description: options.description ?? (kind === "profile" ? "Profile refresh" : "Command"),
        stage: "Waiting", queuedAt: Date.now(), cancellable: options.cancellable ?? false, cancelling: false,
      },
    });
    this.pump();
    return true;
  }

  // Run a handler on the queue, allowing a few requests per chat to line up (FIFO)
  // instead of rejecting a second command while one is still running.
  wrap(handler: Handler, maxPerChat = 3): Handler {
    return async (ctx) => {
      if (!this.submit(ctx.msg.chatId, async () => { await handler(ctx); }, maxPerChat, "command", {
        description: `${ctx.commandTrigger ?? ctx.msg.kind} · ${ctx.msg.chatName || "chat"}`,
        onCancel: () => { void ctx.reply("Your queued request was cancelled by the administrator.").catch(this.onError); },
      })) {
        await ctx.reply("I'm still working through a few requests here — try again shortly.");
      }
    };
  }

  cancel(id: string): "cancelled" | "cancelling" | "not-found" | "unsupported" {
    const index = this.queue.findIndex((job) => job.details.id === id);
    if (index >= 0) {
      const [job] = this.queue.splice(index, 1);
      job.controller.abort(new JobCancelledError());
      job.onCancel?.();
      this.release(job);
      this.cancelled += 1;
      return "cancelled";
    }
    const job = this.activeJob;
    if (!job || job.details.id !== id) return "not-found";
    if (!job.details.cancellable) return "unsupported";
    job.details.cancelling = true;
    if (this.running) this.running.cancelling = true;
    if (!job.controller.signal.aborted) {
      job.controller.abort(new JobCancelledError());
      job.onCancel?.();
    }
    return "cancelling";
  }

  async stop(): Promise<void> {
    this.accepting = false;
    while (this.active) await this.active;
  }

  snapshot(): BackgroundJobsSnapshot {
    return {
      capacity: this.capacity, accepting: this.accepting,
      running: this.running ? { ...this.running } : null,
      queuedJobs: this.queue.map((job) => ({ ...job.details, cancellable: true })),
      queued: this.queue.length, oldestQueuedAt: this.queue[0]?.details.queuedAt ?? null,
      completed: this.completed, cancelled: this.cancelled, failed: this.failed, rejected: { ...this.rejected },
      recentFailures: this.failures.map((failure) => ({ ...failure })),
    };
  }

  private release(job: QueuedJob): void {
    const remaining = (this.pending.get(job.key) ?? 1) - 1;
    if (remaining <= 0) this.pending.delete(job.key);
    else this.pending.set(job.key, remaining);
    this.size -= 1;
  }

  private pump(): void {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    const startedAt = Date.now();
    this.activeJob = job;
    this.running = { ...job.details, stage: "Running", startedAt };
    this.active = Promise.resolve().then(() => {
      job.controller.signal.throwIfAborted();
      return job.run({
        signal: job.controller.signal,
        setStage: (stage) => { if (this.running?.id === job.details.id) this.running.stage = stage; },
      });
    }).then(() => {
      if (job.controller.signal.aborted) this.cancelled += 1;
      else this.completed += 1;
    }).catch((error: unknown) => {
      if (job.controller.signal.aborted) { this.cancelled += 1; return; }
      this.failed += 1;
      this.failures.unshift({ id: this.failed, kind: job.details.kind, startedAt, failedAt: Date.now() });
      this.failures.length = Math.min(this.failures.length, 20);
      this.onError(error);
    }).finally(() => {
      this.release(job);
      this.active = undefined;
      this.activeJob = undefined;
      this.running = null;
      this.pump();
    });
  }
}