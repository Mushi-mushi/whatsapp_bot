import { describe, it, expect } from "vitest";
import { ContactResolver } from "../src/transport/contacts.js";
import type { Contact } from "@whiskeysockets/baileys";

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

  it("skips contacts without a usable display name", () => {
    const r = new ContactResolver();
    const { names, records } = r.ingest([c({ id: "111@s.whatsapp.net" })]);
    expect(names).toEqual([]);
    expect(records).toEqual([]);
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
