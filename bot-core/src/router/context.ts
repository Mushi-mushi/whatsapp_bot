import type { BotConfig } from "../config/schema.js";
import type { ConnectionStatus, IncomingMessage, Transport } from "../transport/types.js";

export interface Services {
  transport: Transport;
  getConfig: () => BotConfig;
}

// The context object handed to middleware and handlers, à la Telegraf/grammY.
export class Context {
  // Populated by the command matcher: the command trigger and its trailing args.
  public commandTrigger: string | null = null;
  public args = "";
  private readonly configSnapshot: BotConfig;

  constructor(
    public readonly msg: IncomingMessage,
    private readonly services: Services,
  ) {
    this.configSnapshot = services.getConfig();
  }

  get config(): BotConfig {
    return this.configSnapshot;
  }

  get connection(): ConnectionStatus {
    return this.services.transport.getStatus();
  }

  get text(): string {
    return this.msg.text ?? "";
  }

  async reply(text: string): Promise<void> {
    await this.services.transport.sendText(this.msg.chatId, this.withPrefix(text));
  }

  async quote(text: string): Promise<void> {
    await this.services.transport.sendReply(this.msg.chatId, this.withPrefix(text), this.msg.raw);
  }

  async sendImage(image: Buffer, caption?: string): Promise<void> {
    await this.services.transport.sendImage(
      this.msg.chatId,
      image,
      caption ? this.withPrefix(caption) : undefined,
    );
  }

  async downloadAudio(): Promise<Buffer> {
    return this.services.transport.downloadAudio(this.msg.raw);
  }

  async downloadImage(): Promise<Buffer> {
    return this.services.transport.downloadImage(this.msg.raw);
  }

  async getQuotedImage(): Promise<Buffer | null> {
    return this.services.transport.downloadQuotedImage(this.msg.raw);
  }

  private withPrefix(text: string): string {
    const prefix = this.config.botReplyPrefix?.trim();
    if (!prefix || text.startsWith(prefix)) return text;
    return `${prefix}\n${text}`;
  }
}
