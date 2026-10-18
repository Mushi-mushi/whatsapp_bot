import { afterEach, describe, it, expect } from "vitest";
import { openDatabase } from "../src/state/db.js";
import { ContactsStore, UserMemoryStore } from "../src/state/repos.js";
import { mentionedUsers, userContextBlock } from "../src/handlers/commands/user-context.js";

import { memoryChat, memoryKey, personKey } from "../src/state/identity.js";

const CHAT = "c@g.us";
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function freshStore(): UserMemoryStore {
  const db = openDatabase(":memory:");
  databases.push(db);
  return new UserMemoryStore(db);
}

describe("UserMemoryStore", () => {
  it("records and returns messages oldest-first", () => {
    const store = freshStore();
    store.record(memoryKey(CHAT, "34600000001"), "Alice", "Group", "hello there", 50);
    store.record(memoryKey(CHAT, "34600000001"), "Alice", "Group", "i love hiking", 50);
    const msgs = store.recentFor(memoryKey(CHAT, "34600000001"));
    expect(msgs.map((m) => m.message)).toEqual(["hello there", "i love hiking"]);
  });

  it("bounds history to the configured limit", () => {
    const store = freshStore();
    for (let i = 0; i < 10; i++) store.record(memoryKey(CHAT, "34600000002"), "Bob", null, `msg ${i}`, 3);
    const msgs = store.recentFor(memoryKey(CHAT, "34600000002"), 100);
    expect(msgs).toHaveLength(3);
    expect(msgs.map((m) => m.message)).toEqual(["msg 7", "msg 8", "msg 9"]);
  });

  it("keeps two people with the same name separate", () => {
    const store = freshStore();
    store.record(memoryKey(CHAT, "34600000001"), "Alex", null, "i'm the first alex", 50);
    store.record(memoryKey(CHAT, "34600000009"), "Alex", null, "i'm the second alex", 50);
    expect(store.recentFor(memoryKey(CHAT, "34600000001")).map((m) => m.message)).toEqual(["i'm the first alex"]);
    expect(store.recentFor(memoryKey(CHAT, "34600000009")).map((m) => m.message)).toEqual(["i'm the second alex"]);
  });

  it("returns every matching identity so ambiguous names are not silently resolved", () => {
    const store = freshStore();
    store.record(memoryKey(CHAT, "34600000001"), "Alex", null, "old alex", 50);
    store.record(memoryKey(CHAT, "34600000009"), "Alex", null, "new alex", 50);
    const match = store.usersForNameInChat("alex", CHAT);
    expect(match.map((u) => u.sender_key)).toEqual([memoryKey(CHAT, "34600000009"), memoryKey(CHAT, "34600000001")]);
  });

  it("lists distinct known identities most-recent first", () => {
    const store = freshStore();
    store.record(memoryKey(CHAT, "34600000001"), "Alice", null, "one", 50);
    store.record(memoryKey(CHAT, "34600000002"), "Bob", null, "two", 50);
    store.record(memoryKey(CHAT, "34600000001"), "Alice", null, "three", 50);
    expect(store.knownUsers(CHAT).map((u) => u.sender_key)).toEqual([memoryKey(CHAT, "34600000001"), memoryKey(CHAT, "34600000002")]);
  });

  it("forgets an identity's history", () => {
    const store = freshStore();
    store.record(memoryKey(CHAT, "34600000001"), "Alice", null, "secret", 50);
    expect(store.forget(memoryKey(CHAT, "34600000001"))).toBe(1);
    expect(store.recentFor(memoryKey(CHAT, "34600000001"))).toHaveLength(0);
  });

  it("isolates retention, names and messages by chat ID despite duplicate chat names", () => {
    const store = freshStore();
    const first = memoryKey(CHAT, "123");
    const other = memoryKey("other@g.us", "123");
    store.record(other, "Alice", "Friends", "private to other chat", 1);
    store.record(first, "Alice", "Friends", "old", 1);
    store.record(first, "Alice", "Renamed group", "new", 1);
    expect(store.recentFor(first).map((m) => m.message)).toEqual(["new"]);
    expect(store.recentFor(other).map((m) => m.message)).toEqual(["private to other chat"]);
    expect(store.usersForNameInChat("alice", CHAT).map((u) => u.sender_key)).toEqual([first]);
    expect(store.usersForNameInChat("alice", "dm@lid")).toEqual([]);
    store.forget(first);
    expect(store.recentFor(other)).toHaveLength(1);
  });

  it("uses the latest recorded name rather than matching historical aliases", () => {
    const store = freshStore();
    const key = memoryKey(CHAT, "123");
    store.record(key, "Alice", null, "old name", 50);
    store.record(key, "Alicia", null, "new name", 50);
    expect(store.usersForNameInChat("alice", CHAT)).toEqual([]);
    expect(store.usersForNameInChat("alicia", CHAT)[0].sender_key).toBe(key);
    expect(store.knownUsers(CHAT)[0].name).toBe("Alicia");
  });

  it("rejects attempts to write unscoped memory", () => {
    const store = freshStore();
    expect(() => store.record("123", "Alice", null, "unscoped", 50)).toThrow();
  });

  it("reconciles historical LID and phone memory in groups and DMs after a verified alias is learned", () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    const store = new UserMemoryStore(db);
    const lidKey = memoryKey(CHAT, "900@lid");
    const phoneKey = memoryKey(CHAT, "34600000001@s.whatsapp.net");
    store.record(lidKey, "Alice", "Group", "lid message", 3);
    store.record(phoneKey, "Alicia", "Group", "phone message", 3);

    new ContactsStore(db).upsertMany([{ jid: "900@lid", phone: "34600000001", name: "" }]);

    expect(store.recentFor(lidKey).map((m) => m.message)).toEqual(["lid message", "phone message"]);
    expect(store.recentFor(phoneKey).map((m) => m.message)).toEqual(["lid message", "phone message"]);
    expect(store.countSince(lidKey, 0)).toBe(2);
    expect(store.knownUsers(CHAT)).toEqual([{ sender_key: phoneKey, name: "Alicia", name_norm: "alicia" }]);
    expect(store.usersForNameInChat("alice", CHAT)).toEqual([]);
    expect(store.usersForNameInChat("alicia", CHAT)).toEqual([{ sender_key: phoneKey, name: "Alicia", name_norm: "alicia" }]);

    // Recording trims across all verified alias keys as one rolling window.
    store.record(lidKey, "Alicia", "Group", "third", 3);
    store.record(phoneKey, "Alicia", "Group", "fourth", 3);
    expect(store.recentFor(lidKey).map((m) => m.message)).toEqual(["phone message", "third", "fourth"]);
    expect(store.forget(lidKey)).toBe(3);
    expect(store.recentFor(phoneKey)).toEqual([]);

    // DM conversations where both chatId and senderId were LID before alias discovery:
    const dmLidKey = memoryKey("900@lid", "900@lid");
    const dmPhoneKey = memoryKey("34600000001@s.whatsapp.net", "34600000001@s.whatsapp.net");
    store.record(dmLidKey, "Alicia", null, "dm from lid", 10);
    expect(store.recentFor(dmPhoneKey).map((m) => m.message)).toEqual(["dm from lid"]);
    expect(store.knownUsers("900@lid")).toEqual([{ sender_key: dmPhoneKey, name: "Alicia", name_norm: "alicia" }]);
  });
});

describe("user-context helpers", () => {
  it("builds a context block from recent messages", () => {
    const store = freshStore();
    store.record(memoryKey(CHAT, "34600000001"), "Alice", null, "i love hiking", 50);
    const block = userContextBlock(store, memoryKey(CHAT, "34600000001"), "Alice", 20, "the person asking");
    expect(block).toContain("About Alice (the person asking)");
    expect(block).toContain('- "i love hiking"');
  });

  it("returns null when the identity is unknown", () => {
    const store = freshStore();
    expect(userContextBlock(store, "nobody", "Nobody", 20, "")).toBeNull();
  });

  it("detects a mentioned known user, excluding the asker", () => {
    const store = freshStore();
    store.record(memoryKey(CHAT, "34600000001"), "Alice", null, "hi", 50);
    store.record(memoryKey(CHAT, "34600000002"), "Bob", null, "yo", 50);
    const found = mentionedUsers(store, "what does bob think?", memoryKey(CHAT, "34600000001"), CHAT);
    expect(found.map((u) => u.sender_key)).toEqual([memoryKey(CHAT, "34600000002")]);
  });

  it("does not match a name embedded inside another word", () => {
    const store = freshStore();
    store.record(memoryKey(CHAT, "34600000003"), "Al", null, "hi", 50);
    // "al" should not match inside "always"; also < 3 chars is skipped anyway.
    expect(mentionedUsers(store, "i always win", "someone", CHAT)).toEqual([]);
  });

  it("ignores people from other chats and ambiguous local mentions", () => {
    const store = freshStore();
    store.record(memoryKey("other@g.us", "1"), "Carol", "Same name", "private", 50);
    store.record(memoryKey(CHAT, "2"), "Alex", "Same name", "one", 50);
    store.record(memoryKey(CHAT, "3"), "Alex", "Same name", "two", 50);
    expect(mentionedUsers(store, "what do Carol and Alex think?", "asker", CHAT)).toEqual([]);
  });
});

describe("chat/person identity", () => {
  it("normalizes phone and device JIDs without treating opaque LIDs as phone numbers", () => {
    expect(personKey("opaque@lid", "+34 (600) 000-001")).toBe("34600000001");
    expect(personKey("34600000001:2@s.whatsapp.net")).toBe("34600000001");
    expect(personKey("123456789@lid")).toBe("123456789@lid");
    expect(memoryKey(CHAT, "opaque@lid", "34600000001"))
      .toBe(memoryKey(CHAT, "34600000001@s.whatsapp.net"));
  });

  it("keeps tuple boundaries and chat identities distinct", () => {
    expect(memoryKey("a,b", "c")).not.toBe(memoryKey("a", "b,c"));
    expect(memoryKey(CHAT, "1")).not.toBe(memoryKey("other@g.us", "1"));
    const key = memoryKey('group"with\\escapes', "opaque@lid");
    expect(memoryChat(key)).toBe('group"with\\escapes');
  });

  it.each(["[]", '["chat"]', '["","person"]', '["chat",null]', '{"chat":"person"}'])(
    "rejects invalid scoped keys: %s", (key) => {
      expect(() => memoryChat(key)).toThrow("Invalid chat-scoped memory key");
    },
  );
});
