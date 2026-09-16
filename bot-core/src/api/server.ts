import Fastify from "fastify";
import cors from "@fastify/cors";
import type { Logger } from "pino";
import { ConfigSchema } from "../config/schema.js";
import type { ConfigStore, KnownChatsStore } from "../state/repos.js";
import type { Transport } from "../transport/types.js";

export interface ApiDeps {
  transport: Transport;
  configStore: ConfigStore;
  knownChats: KnownChatsStore;
  onConfigChange: () => void;
  logger: Logger;
}

export async function startApi(deps: ApiDeps, port: number): Promise<void> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  app.get("/api/status", async () => deps.transport.getStatus());

  app.get("/api/config", async () => deps.configStore.load());

  app.put("/api/config", async (req, reply) => {
    const parsed = ConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.flatten() };
    }
    const saved = deps.configStore.save(parsed.data);
    deps.onConfigChange();
    return { ok: true, config: saved };
  });

  app.get("/api/chats", async () => ({ chats: deps.knownChats.list() }));

  // Re-pull the WhatsApp address book + chats on the live session (no re-link).
  app.post("/api/resync", async (_req, reply) => {
    try {
      await deps.transport.resyncContacts();
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: String(err) };
    }
  });

  // List models available on the configured local Ollama instance.
  app.get("/api/ollama/models", async (_req, reply) => {
    const base = deps.configStore.load().ollamaBaseUrl.replace(/\/+$/, "");
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        reply.code(502);
        return { ok: false, models: [] as string[] };
      }
      const data = (await res.json()) as { models?: { name?: string }[] };
      const models = (data.models ?? []).map((m) => m.name).filter((n): n is string => !!n);
      return { ok: true, models };
    } catch (err) {
      reply.code(502);
      return { ok: false, models: [] as string[], error: String(err) };
    }
  });

  app.post("/api/pair", async (req, reply) => {
    const body = req.body as { phoneNumber?: string } | undefined;
    if (!body?.phoneNumber) {
      reply.code(400);
      return { ok: false, error: "phoneNumber required" };
    }
    try {
      const code = await deps.transport.requestPairingCode(body.phoneNumber);
      return { ok: true, code };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: String(err) };
    }
  });

  // Server-Sent Events: push live connection status (state, QR, pairing code).
  app.get("/api/events", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    send(deps.transport.getStatus());
    const listener = (s: unknown) => send(s);
    deps.transport.onStatus(listener);
    req.raw.on("close", () => reply.raw.end());
  });

  await app.listen({ host: "0.0.0.0", port });
  deps.logger.info({ port }, "API listening");
}
