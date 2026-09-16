import type { MessageKind } from "../transport/types.js";
import { Context } from "./context.js";
import { extractCommandToken } from "./normalize.js";

export type Middleware = (ctx: Context, next: () => Promise<void>) => Promise<void> | void;
export type Handler = (ctx: Context) => Promise<void> | void;

interface CommandEntry {
  trigger: string; // lowercased, e.g. "bot.roast" or "bot.roast.neg"
  handler: Handler;
}

interface HearsEntry {
  pattern: RegExp;
  handler: Handler;
}

// Telegraf/grammY-style router: ordered middleware, then matchers
// (kind handlers -> commands -> hears -> fallback).
export class Bot {
  private middleware: Middleware[] = [];
  private commands: CommandEntry[] = [];
  private hearsList: HearsEntry[] = [];
  private kindHandlers = new Map<MessageKind, Handler>();
  private fallbackHandler: Handler | null = null;

  use(mw: Middleware): this {
    this.middleware.push(mw);
    return this;
  }

  command(trigger: string, handler: Handler): this {
    this.commands.push({ trigger: trigger.toLowerCase(), handler });
    // Longest trigger first so "bot.roast.neg" wins over "bot.roast".
    this.commands.sort((a, b) => b.trigger.length - a.trigger.length);
    return this;
  }

  clearCommands(): this {
    this.commands = [];
    return this;
  }

  hears(pattern: RegExp, handler: Handler): this {
    this.hearsList.push({ pattern, handler });
    return this;
  }

  on(kind: MessageKind, handler: Handler): this {
    this.kindHandlers.set(kind, handler);
    return this;
  }

  fallback(handler: Handler): this {
    this.fallbackHandler = handler;
    return this;
  }

  async handle(ctx: Context): Promise<void> {
    const dispatch = () => this.dispatch(ctx);
    await this.runMiddleware(ctx, 0, dispatch);
  }

  private async runMiddleware(
    ctx: Context,
    index: number,
    final: () => Promise<void>,
  ): Promise<void> {
    if (index >= this.middleware.length) {
      await final();
      return;
    }
    const mw = this.middleware[index];
    await mw(ctx, () => this.runMiddleware(ctx, index + 1, final));
  }

  private async dispatch(ctx: Context): Promise<void> {
    // Non-text media kinds route to their kind handler first (e.g. audio -> transcribe).
    if (ctx.msg.kind !== "text") {
      const kindHandler = this.kindHandlers.get(ctx.msg.kind);
      if (kindHandler) {
        await kindHandler(ctx);
      }
      return;
    }

    // Command match on any embedded "bot.*" token (handles group "Name bot.x" prefixes).
    const token = extractCommandToken(ctx.text);
    if (token) {
      const lower = token.toLowerCase();
      const entry = this.commands.find((c) => lower.startsWith(c.trigger));
      if (entry) {
        ctx.commandTrigger = entry.trigger;
        ctx.args = token.slice(entry.trigger.length).trim();
        await entry.handler(ctx);
        return;
      }
    }

    for (const { pattern, handler } of this.hearsList) {
      if (pattern.test(ctx.text)) {
        await handler(ctx);
        return;
      }
    }

    if (this.fallbackHandler) await this.fallbackHandler(ctx);
  }
}
