import type { Handler } from "../../router/router.js";
import type { ConfigController } from "../../config/controller.js";
import type { BotConfig } from "../../config/schema.js";

type Service = "ollama" | "comfyui" | "all";
type Action = "on" | "off" | "status";

const USAGE = "Use `bot.services [status|on|off] [ollama|comfyui|all]`.";

function serviceStatus(config: BotConfig): string {
  return (
    `Ollama (AI commands): *${config.askEnabled ? "ON" : "OFF"}*\n` +
    `ComfyUI (image/video generation): *${config.paintEnabled ? "ON" : "OFF"}*`
  );
}

export function makeServices(settings: ConfigController): Handler {
  return (ctx) => {
    if (!ctx.msg.fromMe) {
      return ctx.reply("Only the bot owner can change AI services.");
    }

    const args = ctx.args.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let action: Action = "status";
    let service: Service = "all";
    if (args.length === 1) {
      const [arg] = args;
      if (arg === "on" || arg === "off" || arg === "status") action = arg;
      else if (arg === "ollama" || arg === "comfyui" || arg === "all") service = arg;
      else return ctx.reply(USAGE);
    } else if (args.length === 2) {
      const [actionArg, serviceArg] = args;
      if (actionArg !== "on" && actionArg !== "off" && actionArg !== "status") return ctx.reply(USAGE);
      if (serviceArg !== "ollama" && serviceArg !== "comfyui" && serviceArg !== "all") return ctx.reply(USAGE);
      action = actionArg;
      service = serviceArg;
    } else if (args.length > 2) {
      return ctx.reply(USAGE);
    }

    const config = settings.get();
    if (action === "status") {
      if (service === "all") return ctx.reply(serviceStatus(config));
      const enabled = service === "ollama" ? config.askEnabled : config.paintEnabled;
      return ctx.reply(`${service === "ollama" ? "Ollama" : "ComfyUI"} is *${enabled ? "ON" : "OFF"}*.`);
    }

    const enabled = action === "on";
    const patch: Partial<BotConfig> = {};
    if (service === "all" || service === "ollama") patch.askEnabled = enabled;
    if (service === "all" || service === "comfyui") patch.paintEnabled = enabled;

    const changed =
      (patch.askEnabled !== undefined && config.askEnabled !== patch.askEnabled) ||
      (patch.paintEnabled !== undefined && config.paintEnabled !== patch.paintEnabled);
    if (!changed) {
      const subject = service === "all" ? "Both services" : service === "ollama" ? "Ollama" : "ComfyUI";
      const verb = service === "all" ? "are" : "is";
      return ctx.reply(`${subject} ${verb} already *${enabled ? "ON" : "OFF"}*.\n${serviceStatus(config)}`);
    }

    settings.update(patch);
    const subject = service === "all" ? "AI services" : service === "ollama" ? "Ollama" : "ComfyUI";
    return ctx.reply(`${subject} turned *${enabled ? "ON" : "OFF"}*.\n${serviceStatus(settings.get())}`);
  };
}
