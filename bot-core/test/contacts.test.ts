import { afterEach, describe, it, expect } from "vitest";
import { ContactResolver } from "../src/transport/contacts.js";
import type { Contact } from "@whiskeysockets/baileys";
import { openDatabase } from "../src/state/db.js";
import { ContactsStore, KnownChatsStore, SiestaDisciplineStore, disciplineKey } from "../src/state/repos.js";
import { IdentityResolver, personKey } from "../src/state/identity.js";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function database() {
  const db = openDatabase(":memory:");
  databases.push(db);
  return db;
}

const c = (o: Partial<Contact> & { lid?: string }): Partial<Contact> => o as Partial<Contact>;

describe("ContactResolver.ingest", () => {
  it("indexes a phone contact by jid and phone, and emits its name", () => {
    const r = new ContactResolver();
    const { names, records } = r.ingest([
      c({ id: "34696451685@s.whatsapp.net", name: "Work Phone NESTLE" }),
    ]);
    expect(names).toEqual(["Work Phone NESTLE"]);
    expect(records).toContainEqual({
      jid: "34696451685@s.whatsapp.net",
      phone: "34696451685",
      name: "Work Phone NESTLE",
    });
    expect(r.nameForJid("34696451685@s.whatsapp.net")).toBe("Work Phone NESTLE");
    expect(r.nameForPhone("34696451685")).toBe("Work Phone NESTLE");
  });

  it("maps a contact's LID to the same saved name", () => {
    const r = new ContactResolver();
    r.ingest([
      c({ id: "34696451685@s.whatsapp.net", name: "Work Phone NESTLE", lid: "56788175069206@lid" }),
    ]);
    expect(r.nameForJid("56788175069206@lid")).toBe("Work Phone NESTLE");
  });

  it("retains nameless phone identities without inventing display names", () => {
    const r = new ContactResolver();
    const { names, records } = r.ingest([c({ id: "111@s.whatsapp.net" })]);
    expect(names).toEqual([]);
    expect(records).toEqual([{ jid: "111@s.whatsapp.net", phone: "111", name: "" }]);
  });

  describe("verified identity lifecycle", () => {
    it("persists nameless LID-primary aliases and preserves their phone and name on partial updates", () => {
      const db = database();
      const store = new ContactsStore(db);
      const resolver = new ContactResolver();
      store.upsertMany(resolver.ingest([{ id: "900@lid", jid: "34600000001:2@s.whatsapp.net" }]).records);
      expect(new KnownChatsStore(db).list()).toEqual([]);
      const restarted = new ContactResolver();
      restarted.hydrate(() => store.all());
      expect(restarted.canonical("900@lid")).toBe("34600000001@s.whatsapp.net");
      store.upsertMany(restarted.ingest([{ id: "900@lid", name: "Alice" }]).records);
      store.upsertMany([{ jid: "900@lid", phone: null, name: "" }]);
      expect(store.all()).toContainEqual({ jid: "900@lid", phone: "34600000001", name: "Alice" });
      expect(store.identities().canonical("900:3@lid")).toBe("34600000001@s.whatsapp.net");
    });

    it("never merges duplicate names or derives a phone from LID digits", () => {
      const resolver = new ContactResolver();
      resolver.ingest([{ id: "100@lid", name: "Alex" }, { id: "200@lid", name: "Alex" }]);
      expect(resolver.canonical("100@lid")).toBe("100@lid");
      expect(resolver.canonical("200@lid")).toBe("200@lid");
      expect(resolver.phoneFor("100@lid")).toBeUndefined();
      expect(resolver.aliasesFor("100@lid")).toEqual(["100@lid"]);
      expect(personKey("100@lid", "100@lid")).toBe("100@lid");
    });

    it("rejects conflicting aliases transactionally rather than reassigning a known person", () => {
      const store = new ContactsStore(database());
      store.upsertMany([{ jid: "900@lid", phone: "34600000001", name: "Alice" }]);
      expect(() => store.upsertMany([
        { jid: "901@lid", phone: "34600000002", name: "Bob" },
        { jid: "900@lid", phone: "34600000002", name: "Bob" },
      ])).toThrow("Conflicting WhatsApp identity association");
      expect(store.all()).toEqual([{ jid: "900@lid", phone: "34600000001", name: "Alice" }]);
      const identities = new IdentityResolver();
      expect(() => identities.associate("34600000001@s.whatsapp.net", "34600000002")).toThrow();
      expect(() => identities.associate("group@g.us", "34600000001")).toThrow();
      expect(() => identities.associate("900@lid", "900@lid")).toThrow();
    });

    it("normalizes device addresses consistently for memory and discipline", () => {
      expect(personKey("34600000001:2@s.whatsapp.net")).toBe("34600000001");
      expect(disciplineKey("34600000001:2@s.whatsapp.net")).toBe("34600000001@s.whatsapp.net");
      expect(disciplineKey("900@lid", "34600000001:2@s.whatsapp.net")).toBe("34600000001@s.whatsapp.net");
    });

    it("keeps legacy discipline effective after learning an alias without rekeying existing state", () => {
      const db = database();
      const store = new SiestaDisciplineStore(db);
      store.recordAllowedSiesta("900@lid", "900@lid", "2026-10-18");
      store.putToSleep("900@lid", "900@lid", Date.now() + 60_000);
      store.arm("900@lid", "900@lid");
      new ContactsStore(db).upsertMany([{ jid: "900@lid", phone: "34600000001", name: "" }]);
      const pn = "34600000001@s.whatsapp.net";
      expect(store.usedToday(pn, pn, "2026-10-18")).toBe(true);
      expect(store.isArmed(pn, pn)).toBe(true);
      expect(store.sleepUntil(pn, pn)).toBeGreaterThan(Date.now());
      expect(store.sleepUntil("unrelated@g.us", pn)).toBeNull();
      expect(db.prepare("SELECT chat_id, sender_id FROM siesta_discipline").all())
        .toEqual([{ chat_id: "900@lid", sender_id: "900@lid" }]);
      store.putToSleep(pn, pn, Date.now() + 120_000);
      expect(store.isArmed(pn, pn)).toBe(false);
      store.wake("900@lid", "900@lid");
      expect(store.listActive()).toEqual([]);
      expect(store.usedToday(pn, pn, "2026-10-18")).toBe(true);
    });
  });

  it("does not emit group ids as DM names", () => {
    const r = new ContactResolver();
    const { names } = r.ingest([c({ id: "123-456@g.us", name: "Some Group" })]);
    expect(names).toEqual([]);
  });
});

describe("ContactResolver.resolveDmName", () => {
  it("prefers the saved name by phone over the pushName (LID gotcha)", () => {
    const r = new ContactResolver();
    r.ingest([
      c({ id: "34696451685@s.whatsapp.net", name: "Work Phone NESTLE", lid: "56788175069206@lid" }),
    ]);
    const name = r.resolveDmName({
      chatId: "56788175069206@lid",
      phoneJid: "34696451685@s.whatsapp.net",
      senderPhone: "34696451685",
      pushName: "Baptiste",
      senderId: "56788175069206@lid",
    });
    expect(name).toBe("Work Phone NESTLE");
  });

  it("falls back to pushName when the contact is unknown", () => {
    const r = new ContactResolver();
    const name = r.resolveDmName({
      chatId: "999@lid",
      senderPhone: "999",
      pushName: "Stranger",
      senderId: "999@lid",
    });
    expect(name).toBe("Stranger");
  });

  it("falls back to the sender id when there is no name at all", () => {
    const r = new ContactResolver();
    const name = r.resolveDmName({
      chatId: "999@lid",
      senderPhone: "",
      pushName: null,
      senderId: "999@lid",
    });
    expect(name).toBe("999@lid");
  });
});

describe("ContactResolver.hydrate", () => {
  it("loads persisted records once and resolves from them", () => {
    const r = new ContactResolver();
    let calls = 0;
    const load = () => {
      calls += 1;
      return [{ jid: "1@s.whatsapp.net", phone: "1", name: "Alice" }];
    };
    r.hydrate(load);
    r.hydrate(load); // second call is a no-op
    expect(calls).toBe(1);
    expect(r.nameForJid("1@s.whatsapp.net")).toBe("Alice");
    expect(r.nameForPhone("1")).toBe("Alice");
  });
});
