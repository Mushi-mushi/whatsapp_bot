import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditAction } from "../../../shared/api.js";
import type { AuditStore } from "../state/audit.js";

const ACTIONS: Record<string, AuditAction> = {
  "POST /api/reminders": "reminder.create",
  "PUT /api/reminders/:id": "reminder.update",
  "DELETE /api/reminders/:id": "reminder.cancel",
  "DELETE /api/tells/:id": "tell.cancel",
  "DELETE /api/suggestions/:id": "suggestion.delete",
  "POST /api/operations/deliveries/:id/retry": "delivery.retry",
  "DELETE /api/operations/jobs/:id": "job.cancel",
  "POST /api/usage/reset": "usage.reset",
  "PUT /api/config": "config.save",
  "PUT /api/pets/:chatId": "pet.update",
  "POST /api/pets/:chatId/request": "pet.request",
  "POST /api/pets/:chatId/evolve": "pet.evolve",
  "POST /api/profiles/:key/refresh": "profile.refresh",
  "DELETE /api/profiles/:key": "profile.forget",
  "POST /api/siesta/cancel": "siesta.cancel",
  "POST /api/discipline/sleep": "discipline.sleep",
  "POST /api/discipline/arm": "discipline.arm",
  "POST /api/discipline/wake": "discipline.wake",
  "POST /api/trivia/reset": "trivia.reset",
  "POST /api/trivia/close-month": "trivia.close-month",
  "POST /api/pair": "connection.pair",
  "POST /api/resync": "connection.resync",
  "POST /api/relink": "connection.relink",
};

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function registerAudit(app: FastifyInstance, store: AuditStore, apiToken?: string): void {
  const pending = new WeakMap<FastifyRequest, { id: number; action: AuditAction }>();
  const key = apiToken || randomUUID();
  const opaque = (kind: string, value: string) =>
    `${kind}:${createHmac("sha256", key).update(`${kind}:${value}`).digest("hex")}`;
  const target = (req: FastifyRequest, action: AuditAction): string | null => {
    const params = object(req.params);
    if (typeof params.id === "string") {
      if (action === "job.cancel") return opaque("job", params.id);
      const id = Number(params.id);
      return /^[1-9]\d*$/.test(params.id) && Number.isSafeInteger(id) ? String(id) : null;
    }
    if (action === "reminder.create") {
      const body = object(req.body);
      if (typeof body.chatId === "string" && body.chatId.trim()) return opaque("chat", body.chatId.trim());
    }
    if (typeof params.chatId === "string") return opaque("chat", params.chatId);
    if (typeof params.key === "string") return opaque("profile", params.key);
    if (action === "usage.reset") {
      const body = object(req.body);
      if (typeof body.senderId === "string" && typeof body.command === "string") {
        return opaque("usage", JSON.stringify([body.command, body.senderId]));
      }
    }
    if (action.startsWith("discipline.")) {
      const body = object(req.body);
      if (typeof body.chatId === "string" && typeof body.senderId === "string") {
        return opaque("player", JSON.stringify([body.chatId, body.senderId]));
      }
    }
    return null;
  };
  app.addHook("onRoute", (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !ACTIONS[`${method} ${route.url}`]) {
        throw new Error(`Administrative mutation is missing an audit action: ${method} ${route.url}`);
      }
    }
  });
  // Registered after authentication: unauthenticated requests never enter the administrative history.
  app.addHook("onRequest", async (req, reply) => {
    if (reply.sent) return;
    const action = ACTIONS[`${req.method} ${req.routeOptions.url}`];
    if (!action) return;
    reply.header("Cache-Control", "no-store");
    const targetId = target(req, action);
    const id = store.begin(action, targetId, apiToken ? "authenticated-api" : "local-insecure-api");
    pending.set(req, { id, action });
  });
  app.addHook("onSend", async (req, reply, payload) => {
    const entry = pending.get(req);
    if (!entry) return payload;
    // Remove before writing so a failed completion cannot loop through the error response hook.
    pending.delete(req);
    let action = entry.action;
    const petAction = object(req.body).action;
    if (action === "pet.update") {
      switch (petAction) {
        case "save": action = "pet.save"; break;
        case "enable": action = "pet.enable"; break;
        case "disable": action = "pet.disable"; break;
        case "pause": action = "pet.pause"; break;
        case "resume": action = "pet.resume"; break;
      }
    }
    store.complete(entry.id, action, target(req, action), reply.statusCode);
    return payload;
  });
}
