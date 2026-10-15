import type { Logger } from "pino";
import type { Delivery, OutboxStore } from "./outbox.js";

interface DeliveryHooks {
  canSend: (delivery: Delivery) => boolean | "defer";
  onSent: (delivery: Delivery) => void;
}

export class DeliveryWorker {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly store: OutboxStore,
    private readonly send: (chatId: string, body: string, delivery: Delivery) => Promise<void>,
    private readonly logger: Logger,
    private readonly isReady: () => boolean = () => true,
    private readonly hooks?: DeliveryHooks,
  ) {}

  start(): void {
    this.timer = setInterval(() => { void this.flush().catch((err) => this.logger.error({ err }, "delivery worker failed")); }, 1000);
  }

  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.active) this.active = this.deliver().finally(() => { this.active = undefined; });
    return this.active;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.active;
  }

  private async deliver(): Promise<void> {
    this.store.enqueueReminders(Date.now());
    for (let count = 0; count < 25 && !this.stopped; count += 1) {
      if (!this.isReady()) break;
      const delivery = this.store.claim(Date.now());
      if (!delivery) break;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const decision = this.hooks?.canSend(delivery);
        if (decision === "defer") {
          this.store.defer(delivery, Date.now());
          continue;
        }
        if (decision === false) {
          this.store.cancel(delivery);
          continue;
        }
        await Promise.race([
          this.send(delivery.chat_id, delivery.body, delivery),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("Delivery timed out")), 30_000);
          }),
        ]);
        this.store.sent(delivery, () => this.hooks?.onSent(delivery));
      } catch (err) {
        this.store.failed(delivery, err, Date.now());
        this.logger.warn({ id: delivery.id, attempts: delivery.attempts, err }, "delivery failed");
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}