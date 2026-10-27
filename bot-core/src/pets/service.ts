import type { Logger } from "pino";
import type { BotConfig } from "../config/schema.js";
import type { IncomingMessage } from "../transport/types.js";
import type { Delivery } from "../state/outbox.js";
import { PetStore } from "./store.js";
import {
  awake, createPet, DAY, HOUR, RIDDLES, STAGES, SPECIES, SPECIES_IDS, parsePetEnable, rescueText, statusText, title, needsCare,
  type Pet, type RequestKind,
} from "./model.js";
import { petSettings, type PetSettings } from "./settings.js";

const MISSED_REQUEST_PENALTY = 20;

export class PetService {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    readonly store: PetStore,
    private readonly getConfig: () => BotConfig,
    private readonly isReady: () => boolean,
    private readonly random: () => number = Math.random,
  ) {
    this.store.transaction(() => {
      for (const pet of store.all()) {
        // An offline interval cannot prove that a group stayed silent.
        if (pet.request?.kind === "silence" && pet.request.startedAt !== null) this.cancelRequest(pet);
        pet.lastTick = Date.now();
        store.save(pet);
      }
    });
  }

  start(logger: Logger): void {
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        logger.error({ err }, "pet scheduler failed");
      }
    }, 15_000);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private approved(chatId: string): boolean {
    return this.getConfig().approvedSenders.includes(chatId);
  }

  tick(now = Date.now()): void {
    this.store.transaction(() => {
      for (const pet of this.store.all()) {
        this.advance(pet, now);
        if (this.canAct(pet) && !pet.hibernating && !pet.request &&
          pet.clock >= pet.nextRequest && awake(pet, now) &&
          now - pet.lastActivity <= pet.activityWindowHours * HOUR) {
          const day = new Date(now).toISOString().slice(0, 10);
          if (pet.requestDay !== day) {
            pet.requestDay = day;
            pet.requestsToday = 0;
          }
          if (pet.requestsToday < pet.maxRequestsPerDay) this.request(pet, now);
        }
        this.store.save(pet);
      }
    });
  }

  private canAct(pet: Pet): boolean {
    return pet.enabled && !pet.paused && this.approved(pet.chatId) && this.isReady();
  }

  evolutionStatus(pet: Pet, now = Date.now()) {
    const next = STAGES[pet.stage + 1];
    const unavailable = !pet.enabled ? "Pet is disabled."
      : pet.paused ? "Pet is paused."
      : !this.approved(pet.chatId) ? "Group is not approved."
      : !this.isReady() ? "Bot is offline or reconnecting."
      : pet.hibernating ? "Pet is hibernating; complete its rescue first."
      : null;
    const frozenReason = unavailable ?? (needsCare(pet) ? "Needs are critical; restore all five stats above 20."
      : now - pet.lastTick > 90_000 ? "Waiting for the pet scheduler to resume." : null);
    return {
      nextForm: next ? SPECIES[pet.species].forms[pet.stage + 1] : null,
      remainingHealthyMs: next ? Math.max(0, next.days * DAY - pet.healthyMs) : 0,
      sampledAt: Math.min(now, pet.lastTick),
      running: !!next && !frozenReason,
      frozenReason: next ? frozenReason : null,
      canForce: !!next && !unavailable,
    };
  }

  evolveNow(chatId: string, expectedStage: number, now = Date.now()): { ok: true } | { ok: false; error: string } {
    return this.store.transaction(() => {
      const pet = this.store.get(chatId);
      if (!pet) return { ok: false, error: "Spawn a pet first." };
      this.advance(pet, now);
      this.store.save(pet);
      if (pet.stage !== expectedStage) return { ok: false, error: "Pet's form changed. Reload pets before evolving again." };
      if (!this.canAct(pet)) return { ok: false, error: "Pet must be enabled, resumed, approved, and connected." };
      if (pet.hibernating) return { ok: false, error: "Rescue the hibernating pet before evolving it." };
      if (!STAGES[pet.stage + 1]) return { ok: false, error: "This pet has already reached its final form." };
      this.cancelRequest(pet);
      this.evolve(pet, now, true);
      this.store.save(pet);
      return { ok: true };
    });
  }

  private evolve(pet: Pet, now: number, forced = false): void {
    pet.stage += 1;
    const days = STAGES[pet.stage].days;
    if (forced) pet.healthyMs = days * DAY;
    this.store.enqueue(pet, `${title(pet)}\n${forced
      ? `An owner gave me an evolution boost! My healthy-time progress is now ${days} days.`
      : `I evolved! You have kept me healthy for ${days} days. Thank you for raising me together!`}`, now);
  }

  private cancelRequest(pet: Pet): void {
    if (pet.request) this.store.cancel(pet.chatId, pet.request.eventId);
    pet.request = null;
  }

  private advance(pet: Pet, now: number): void {
    const gap = Math.max(0, now - pet.lastTick);
    pet.lastTick = now;
    if (!pet.enabled || pet.paused || !this.approved(pet.chatId)) {
      this.store.cancel(pet.chatId);
      pet.request = null;
      return;
    }
    if (!this.isReady() || gap > 90_000) {
      if (pet.request?.kind === "silence" && pet.request.startedAt !== null) this.cancelRequest(pet);
      return;
    }
    pet.clock += gap;
    if (pet.request && this.store.deliveryFailed(pet.request.eventId)) {
      this.cancelRequest(pet);
      pet.nextRequest = pet.clock + pet.requestMinHours * HOUR;
    }
    if (pet.hibernating) {
      pet.hibernationMs += gap;
      if (!pet.devolved && pet.hibernationMs >= 2 * DAY) {
        const lostForm = pet.stage > 0;
        pet.stage = Math.max(0, pet.stage - 1);
        pet.healthyMs = STAGES[pet.stage].days * DAY;
        pet.devolved = true;
        this.store.cancel(pet.chatId);
        this.store.enqueue(pet, `${title(pet)}\n${lostForm
          ? "Too much time asleep... I have reverted to this form, but I remember you."
          : "Still asleep in my egg... I cannot lose another form, and you can still rescue me."}\n${rescueText(pet)}`, now);
      }
      return;
    }
    const oldCritical = needsCare(pet);
    if (pet.clock >= pet.graceUntil) {
      pet.hunger = Math.max(0, pet.hunger - gap / (48 * HOUR) * 100);
      pet.hydration = Math.max(0, pet.hydration - gap / (48 * HOUR) * 100);
      pet.cleanliness = Math.max(0, pet.cleanliness - gap / (72 * HOUR) * 100);
      pet.happiness = Math.max(0, pet.happiness - gap / (72 * HOUR) * 100);
      pet.energy = Math.max(0, Math.min(100, pet.energy + gap / HOUR * (awake(pet, now) ? -2 : 8)));
    }
    const critical = needsCare(pet);
    if (critical) {
      pet.criticalMs += gap;
      if (!pet.warned) {
        pet.warned = true;
        this.store.enqueue(pet, `${title(pet)}\nI need care! Check bot.pet, then use bot.pet feed, water, clean or play. If my needs stay critical for 8 hours, I will hibernate.`, now);
      }
      if (pet.criticalMs >= 8 * HOUR) {
        this.cancelRequest(pet);
        this.store.cancel(pet.chatId);
        pet.hibernating = true;
        pet.hibernationMs = 0;
        pet.devolved = false;
        pet.rescueFed = false;
        pet.rescueAnswered = false;
        pet.rescueRiddle = Math.floor(this.random() * RIDDLES.length);
        this.store.enqueue(pet, `${title(pet)}\nI have gone into hibernation. Rescue me before 48 hours pass to avoid losing one form.\n${rescueText(pet)}`, now);
      }
    } else {
      pet.criticalMs = 0;
      pet.warned = false;
      if (!oldCritical) pet.healthyMs += gap;
      const next = STAGES[pet.stage + 1];
      if (next && pet.healthyMs >= next.days * DAY) {
        this.evolve(pet, now);
      }
    }
    if (pet.request && pet.request.deadline !== null && pet.clock >= pet.request.deadline) {
      if (pet.request.kind === "silence") {
        pet.energy = Math.min(100, pet.energy + 60);
        pet.happiness = Math.min(100, pet.happiness + 10);
        this.finishRequest(pet, "Such a peaceful nap! Silence challenge complete.", now);
      } else {
        this.penalizeMissedRequest(pet, pet.request.kind);
        this.finishRequest(pet, "Maybe next time! My request has expired.", now);
      }
    }
  }

  requestNow(chatId: string, now = Date.now(), kind?: RequestKind): { ok: true } | { ok: false; error: string } {
    return this.store.transaction(() => {
      const pet = this.store.get(chatId);
      if (!pet) return { ok: false, error: "Spawn a pet first." };
      this.advance(pet, now);
      this.store.save(pet);
      if (!this.canAct(pet)) return { ok: false, error: "Pet must be enabled, resumed, approved, and connected." };
      if (pet.hibernating) return { ok: false, error: "Rescue the hibernating pet before requesting a challenge." };
      if (pet.request) return { ok: false, error: "This pet already has an active or queued request." };
      this.request(pet, now, true, kind);
      this.store.save(pet);
      return { ok: true };
    });
  }

  private request(pet: Pet, now: number, manual = false, selectedKind?: RequestKind): void {
    const kinds: RequestKind[] = ["feed", "water", "clean"];
    if (pet.stage >= 1) kinds.push("play");
    if (pet.stage >= 2) kinds.push("silence");
    const kind = selectedKind ?? kinds[Math.floor(this.random() * kinds.length)];
    const answer = String(1 + Math.floor(this.random() * 5));
    const prompt = kind === "feed" ? `My tummy is rumbling! Someone use bot.pet feed within ${pet.responseMinutes} minutes.`
      : kind === "water" ? `I am thirsty! Someone use bot.pet water within ${pet.responseMinutes} minutes.`
      : kind === "clean" ? `I got muddy! Someone use bot.pet clean within ${pet.responseMinutes} minutes.`
      : kind === "play" ? `Guess my number from 1 to 5! Use bot.pet answer <number> within ${pet.responseMinutes} minutes.`
      : `I need a nap. Can everyone stay silent for ${pet.silenceMinutes} minutes? Any human message, even a sticker or command, wakes me!`;
    const eventId = this.store.enqueue(pet, `${title(pet)}\n${prompt}`, now, kind);
    pet.request = { eventId, kind, answer, startedAt: null, deadline: null, manual };
    pet.nextRequest = pet.clock + this.requestInterval(pet);
  }

  private requestInterval(pet: Pet): number {
    return (pet.requestMinHours + this.random() * (pet.requestMaxHours - pet.requestMinHours)) * HOUR;
  }

  private finishRequest(pet: Pet, message: string, now: number): void {
    this.cancelRequest(pet);
    this.store.enqueue(pet, `${title(pet)}\n${message}`, now);
  }

  observe(msg: IncomingMessage, now = Date.now()): void {
    const prefix = this.getConfig().botReplyPrefix.trim();
    if (!msg.isGroup || msg.isBot || msg.raw.message?.protocolMessage || !this.approved(msg.chatId) ||
      (msg.fromMe && prefix && msg.text?.trimStart().startsWith(prefix))) return;
    const pet = this.store.get(msg.chatId);
    if (!pet?.enabled || pet.paused) return;
    this.store.transaction(() => {
      this.advance(pet, now);
      // Ignore delayed history as evidence of current activity or challenge answers.
      if (this.canAct(pet) && msg.timestamp >= now - 90_000 && msg.timestamp <= now + 30_000) {
        pet.lastActivity = now;
        const request = pet.request;
        if (request?.kind === "silence" && request.startedAt !== null &&
          msg.timestamp >= Math.floor(request.startedAt / 1000) * 1000) {
          pet.energy = Math.max(0, pet.energy - MISSED_REQUEST_PENALTY);
          this.finishRequest(pet, "Whoops, you woke me before my nap was over. My energy dropped.", now);
        } else if (!/bot\./i.test(msg.text ?? "") && msg.kind === "text") {
          this.answer(pet, msg.text ?? "", now);
        }
      }
      this.store.save(pet);
    });
  }

  canDeliver(delivery: Delivery): boolean {
    if (!delivery.pet_event_id) return true;
    const event = this.store.event(delivery.pet_event_id);
    const pet = this.store.get(delivery.chat_id);
    return !!event && !!pet && this.store.isSending(delivery) &&
      pet.enabled && !pet.paused && this.approved(pet.chatId) &&
      (!event.request_kind || pet.request?.eventId === event.id);
  }

  deliveryDecision(delivery: Delivery): boolean | "defer" {
    if (!this.canDeliver(delivery)) return false;
    if (delivery.pet_event_id) {
      const pet = this.store.get(delivery.chat_id);
      if (!pet) throw new Error("Pet disappeared during delivery");
      const manual = pet.request?.eventId === delivery.pet_event_id && pet.request.manual;
      if (!this.isReady() || (!manual && !awake(pet, Date.now()))) return "defer";
      const event = this.store.event(delivery.pet_event_id);
      if (!manual && event?.request_kind && pet.request?.startedAt === null &&
        (Date.now() - pet.lastActivity > pet.activityWindowHours * HOUR ||
          pet.maxRequestsPerDay === 0 ||
          (pet.requestDay === new Date().toISOString().slice(0, 10) && pet.requestsToday >= pet.maxRequestsPerDay))) {
        return "defer";
      }
    }
    return true;
  }

  delivered(delivery: Delivery, now = Date.now()): void {
    if (!delivery.pet_event_id) return;
    this.store.markSent(delivery.pet_event_id, now);
    const pet = this.store.get(delivery.chat_id);
    if (!pet || pet.request?.eventId !== delivery.pet_event_id || pet.request.startedAt !== null) return;
    this.advance(pet, now);
    if (pet.request?.eventId === delivery.pet_event_id) {
      pet.request.startedAt = now;
      pet.request.deadline = pet.clock + (pet.request.kind === "silence" ? pet.silenceMinutes : pet.responseMinutes) * 60_000;
      const day = new Date(now).toISOString().slice(0, 10);
      if (pet.requestDay !== day) {
        pet.requestDay = day;
        pet.requestsToday = 0;
      }
      pet.requestsToday += 1;
      pet.nextRequest = pet.clock + this.requestInterval(pet);
    }
    this.store.save(pet);
  }

  private answer(pet: Pet, raw: string, now: number): boolean {
    const answer = raw.trim().toLowerCase().replace(/[.!?]+$/, "");
    if (pet.hibernating) {
      if (RIDDLES[pet.rescueRiddle].answers.includes(answer)) {
        pet.rescueAnswered = true;
        this.tryRevive(pet, now);
        return true;
      }
    } else if (pet.request?.kind === "play" && pet.request.startedAt !== null && answer === pet.request.answer) {
      pet.happiness = Math.min(100, pet.happiness + 30);
      this.finishRequest(pet, "You guessed it! Thanks for playing with me.", now);
      return true;
    }
    return false;
  }

  private penalizeMissedRequest(pet: Pet, kind: Exclude<RequestKind, "silence">): void {
    const stat = kind === "feed" ? "hunger"
      : kind === "water" ? "hydration"
      : kind === "clean" ? "cleanliness"
      : "happiness";
    pet[stat] = Math.max(0, pet[stat] - MISSED_REQUEST_PENALTY);
  }

  private tryRevive(pet: Pet, now: number): void {
    if (!pet.rescueFed || !pet.rescueAnswered) return;
    pet.hibernating = false;
    pet.hibernationMs = 0;
    pet.criticalMs = 0;
    pet.warned = false;
    pet.hunger = pet.hydration = pet.cleanliness = pet.happiness = pet.energy = 60;
    pet.graceUntil = pet.clock + DAY;
    pet.nextRequest = pet.clock + pet.requestMinHours * HOUR;
    this.store.cancel(pet.chatId);
    this.store.enqueue(pet, `${title(pet)}\nYou rescued me! I am awake, with a 24-hour grace period. Let's earn my next evolution together.`, now);
  }

  command(chatId: string, sub: string, rest: string, now = Date.now(), onCare?: () => void): string {
    return this.store.transaction(() => {
      if (!this.approved(chatId)) return "This group is no longer approved. Approve it in the dashboard first.";
      let pet = this.store.get(chatId);
      if (sub === "enable") {
        const options = parsePetEnable(rest);
        if (options.error) return options.error;
        if (pet && options.species && options.species !== pet.species) {
          return `This group's pet is a ${SPECIES[pet.species].name}. Re-enabling preserves its species and progress.`;
        }
        if (pet?.enabled) return "This group already has a pet. Use bot.pet or bot.pet resume.";
        if (!pet) {
          const species = options.species ?? SPECIES_IDS[Math.floor(this.random() * SPECIES_IDS.length)];
          pet = createPet(chatId, options.name, now, species);
          this.store.save(pet);
          this.store.enqueue(pet, `${title(pet)}\nA ${SPECIES[pet.species].name} egg has arrived! Raise me with bot.pet feed and bot.pet play. Use bot.pet help for the rules.`, now);
        } else {
          pet.enabled = true;
          pet.paused = false;
          pet.lastTick = now;
          pet.lastActivity = now;
          this.store.save(pet);
        }
        return `${pet.name} (${SPECIES[pet.species].name}) is enabled for this group. Progress is saved when disabled or paused.`;
      }
      if (!pet) return "No pet in this group yet. Ask the owner or a group admin to use bot.pet enable <name>.";
      this.advance(pet, now);
      let response: string;
      let cared = false;
      if (!sub || sub === "status") response = statusText(pet);
      else if (sub === "disable" || sub === "pause") {
        if (sub === "disable") pet.enabled = false;
        else pet.paused = true;
        this.cancelRequest(pet);
        this.store.cancel(chatId);
        response = `${pet.name} is ${sub === "disable" ? "disabled" : "paused"}. All progress is saved; no neglect accumulates.`;
      } else if (sub === "resume") {
        if (!pet.enabled) response = "Use bot.pet enable to re-enable this pet.";
        else {
          pet.paused = false;
          pet.lastActivity = now;
          response = `${pet.name} is back!`;
        }
      } else if (sub === "rename") {
        pet.name = rest;
        response = `Your pet is now called ${rest}.`;
      } else if (sub === "hours") {
        const [start, end] = rest.split(/\s+/).map(Number);
        pet.wakeStart = start;
        pet.wakeEnd = end;
        response = `Waking hours set to ${start}:00-${end}:00 UTC.`;
      } else if (!this.canAct(pet)) response = "Your pet is paused, disabled, or offline. Ask an admin to enable/resume it when connected.";
      else if (sub === "revive") response = pet.hibernating ? rescueText(pet) : "Your pet is already awake.";
      else if (sub === "feed") {
        if (pet.hibernating) {
          cared = !pet.rescueFed;
          pet.rescueFed = true;
          this.tryRevive(pet, now);
          response = pet.hibernating ? `A snack is ready!\n${rescueText(pet)}` : "Rescue complete!";
        } else if (pet.clock - pet.lastFeed < HOUR && !(pet.request?.kind === "feed" && pet.request.startedAt !== null)) {
          response = "Still full from that snack! Feeding has a one-hour cooldown.";
        } else {
          cared = true;
          pet.lastFeed = pet.clock;
          pet.hunger = Math.min(100, pet.hunger + 35);
          if (pet.request?.kind === "feed" && pet.request.startedAt !== null) this.finishRequest(pet, "Delicious! Feeding request complete.", now);
          response = "Yum! Food restored.";
        }
      } else if (sub === "water" || sub === "clean") {
        if (pet.hibernating) response = `I am hibernating; complete my rescue quest first.\n${rescueText(pet)}`;
        else {
          const last = sub === "water" ? "lastWater" : "lastClean";
          const stat = sub === "water" ? "hydration" : "cleanliness";
          const requested = pet.request?.kind === sub && pet.request.startedAt !== null;
          if (pet.clock - pet[last] < HOUR && !requested) {
            response = `${sub === "water" ? "Watering" : "Cleaning"} has a one-hour cooldown.`;
          } else {
            cared = true;
            pet[last] = pet.clock;
            pet[stat] = Math.min(100, pet[stat] + 35);
            if (requested) this.finishRequest(pet, `${sub === "water" ? "Refreshing!" : "Squeaky clean!"} Request complete.`, now);
            response = sub === "water" ? "Refreshing! Water restored." : "Squeaky clean! Cleanliness restored.";
          }
        }
      } else if (sub === "play") {
        if (pet.hibernating) response = rescueText(pet);
        else if (pet.request?.kind === "play") response = "Guess a number from 1 to 5 with bot.pet answer <number> once my request arrives.";
        else if (pet.clock - pet.lastPlay < HOUR) response = "Let's rest a little! Playing has a one-hour cooldown.";
        else {
          cared = true;
          pet.lastPlay = pet.clock;
          pet.happiness = Math.min(100, pet.happiness + 25);
          pet.energy = Math.min(100, pet.energy + 10);
          response = "That was fun! Happiness and energy restored.";
        }
      } else if (sub === "answer") {
        const activeNumberGame =
          !pet.hibernating && pet.request?.kind === "play" && pet.request.startedAt !== null;
        const newAnswer = !pet.hibernating || !pet.rescueAnswered;
        if (this.answer(pet, rest, now)) {
          cared = newAnswer;
          response = pet.hibernating ? `That's right!\n${rescueText(pet)}` : "That's right!";
        } else if (activeNumberGame) {
          response = "Not quite! Guess again from 1 to 5 with bot.pet answer <number> while the request is active.";
        } else {
          response = "No matching answer. Check bot.pet for the current request or rescue riddle.";
        }
      } else response = "Unknown pet command. Use bot.pet help.";
      this.store.save(pet);
      if (cared) onCare?.();
      return response;
    });
  }

  configure(chatId: string, settings: PetSettings, name: string, now = Date.now()): void {
    this.store.transaction(() => {
      const pet = this.store.get(chatId);
      if (!pet) throw new Error("Create a pet before changing its settings.");
      this.advance(pet, now);
      const previous = petSettings(pet);
      Object.assign(pet, settings, { name });
      if (pet.request?.startedAt === null &&
        (previous.responseMinutes !== settings.responseMinutes || previous.silenceMinutes !== settings.silenceMinutes)) {
        this.cancelRequest(pet);
      }
      if (pet.requestsToday === 0 && !pet.request &&
        pet.nextRequest === previous.firstRequestMinutes * 60_000) {
        pet.nextRequest = settings.firstRequestMinutes * 60_000;
      } else if (previous.requestMinHours !== settings.requestMinHours ||
        previous.requestMaxHours !== settings.requestMaxHours) {
        pet.nextRequest = pet.clock + this.requestInterval(pet);
      }
      if (settings.maxRequestsPerDay === 0 && pet.request?.startedAt === null && !pet.request.manual) this.cancelRequest(pet);
      this.store.save(pet);
    });
  }
}
