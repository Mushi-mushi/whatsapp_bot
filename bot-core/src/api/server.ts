import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import { ConfigSchema } from "../config/schema.js";
import { redactSecrets, restoreSecrets } from "../config/secrets.js";
import type { ConfigStore, KnownChatsStore, TriviaScoreStore } from "../state/repos.js";
import type { Transport } from "../transport/types.js";

export interface ApiDeps {
  transport: Transport;
  configStore: ConfigStore;
  knownChats: KnownChatsStore;
  triviaScores: TriviaScoreStore;
  onConfigChange: () => void;
  logger: Logger;
  apiToken?: string;
  allowInsecureApi?: boolean;
}

function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function revision(config: unknown): string {
  return `"${createHash("sha256").update(JSON.stringify(config)).digest("hex")}"`;
}

function extractToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  return null;
}

export async function createApi(deps: ApiDeps): Promise<FastifyInstance> {
  if (!deps.apiToken && !deps.allowInsecureApi) throw new Error("API_TOKEN is required");
  const app = Fastify({ logger: false });
  const streams = new Set<() => void>();
  app.addHook("preClose", async () => { for (const close of streams) close(); });

  if (deps.apiToken) {
    const token = deps.apiToken;
    app.addHook("onRequest", async (req, reply) => {
      const provided = extractToken(req);
      if (!provided || !tokensMatch(provided, token)) {
        reply.code(401).send({ ok: false, error: "unauthorized" });
      }
    });
  } else {
    deps.logger.warn("API_TOKEN not set — the API and dashboard are UNAUTHENTICATED.");
  }

  app.get("/api/status", async () => deps.transport.getStatus());
  app.get("/api/health", async () => ({ ok: true, connection: deps.transport.getStatus().state }));

  app.get("/api/config", async (_req, reply) => {
    const config = deps.configStore.load();
    reply.header("ETag", revision(config));
    reply.header("Cache-Control", "no-store");
    return redactSecrets(config);
  });

  app.put("/api/config", async (req, reply) => {
    const current = deps.configStore.load();
    if (!req.headers["if-match"]) {
      return reply.code(428).send({ ok: false, error: "Reload configuration before saving." });
    }
    if (req.headers["if-match"] !== revision(current)) {
      return reply.code(412).send({ ok: false, error: "Configuration changed elsewhere. Reload before saving; your edits have not been applied." });
    }
    const parsed = ConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: parsed.error.flatten() };
    }
    const merged = restoreSecrets(parsed.data, current);
    const saved = deps.configStore.save(merged);
    deps.onConfigChange();
    reply.header("ETag", revision(saved));
    return { ok: true, config: redactSecrets(saved) };
  });

  app.get("/api/chats", async () => ({ chats: deps.knownChats.list() }));

  // Wipe the trivia leaderboard (all chats).
  app.post("/api/trivia/reset", async () => {
    deps.triviaScores.clearAll();
    return { ok: true };
  });

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
  app.get("/api/events", (_req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let closed = false;
    let unsubscribe = () => {};
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(close);
      reply.raw.end();
    };
    const send = (data: unknown) => {
      if (!closed && !reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)) close();
    };
    unsubscribe = deps.transport.onStatus(send);
    streams.add(close);
    reply.raw.on("close", close);
    reply.raw.on("error", close);
    const heartbeat = setInterval(() => { if (!reply.raw.write(": heartbeat\n\n")) close(); }, 15_000);
    heartbeat.unref();
    send(deps.transport.getStatus());
  });

  return app;
}

export async function startApi(deps: ApiDeps, port: number): Promise<FastifyInstance> {
  const app = await createApi(deps);
  await app.listen({ host: deps.apiToken ? "0.0.0.0" : "127.0.0.1", port });
  deps.logger.info({ port }, "API listening");
  return app;
}
