import { describe, it, expect } from "vitest";
import { openDatabase } from "../src/state/db.js";
import { UserMemoryStore } from "../src/state/repos.js";
import { mentionedUsers, userContextBlock } from "../src/handlers/commands/user-context.js";

function freshStore(): UserMemoryStore {
  return new UserMemoryStore(openDatabase(":memory:"));
}

describe("UserMemoryStore", () => {
  it("records and returns messages oldest-first", () => {
    const store = freshStore();
    store.record("34600000001", "Alice", "Group", "hello there", 50);
    store.record("34600000001", "Alice", "Group", "i love hiking", 50);
    const msgs = store.recentFor("34600000001");
    expect(msgs.map((m) => m.message)).toEqual(["hello there", "i love hiking"]);
  });

  it("bounds history to the configured limit", () => {
    const store = freshStore();
    for (let i = 0; i < 10; i++) store.record("34600000002", "Bob", null, `msg ${i}`, 3);
    const msgs = store.recentFor("34600000002", 100);
    expect(msgs).toHaveLength(3);
    expect(msgs.map((m) => m.message)).toEqual(["msg 7", "msg 8", "msg 9"]);
  });

  it("keeps two people with the same name separate", () => {
    const store = freshStore();
    store.record("34600000001", "Alex", null, "i'm the first alex", 50);
    store.record("34600000009", "Alex", null, "i'm the second alex", 50);
    expect(store.recentFor("34600000001").map((m) => m.message)).toEqual(["i'm the first alex"]);
    expect(store.recentFor("34600000009").map((m) => m.message)).toEqual(["i'm the second alex"]);
  });

  it("resolves a name to the most-recently-active identity", () => {
    const store = freshStore();
    store.record("34600000001", "Alex", null, "old alex", 50);
    store.record("34600000009", "Alex", null, "new alex", 50);
    const match = store.keyForName("alex");
    expect(match?.sender_key).toBe("34600000009");
  });

  it("lists distinct known identities most-recent first", () => {
    const store = freshStore();
    store.record("34600000001", "Alice", null, "one", 50);
    store.record("34600000002", "Bob", null, "two", 50);
    store.record("34600000001", "Alice", null, "three", 50);
    expect(store.knownUsers().map((u) => u.sender_key)).toEqual(["34600000001", "34600000002"]);
  });

  it("forgets an identity's history", () => {
    const store = freshStore();
    store.record("34600000001", "Alice", null, "secret", 50);
    expect(store.forget("34600000001")).toBe(1);
    expect(store.recentFor("34600000001")).toHaveLength(0);
  });
});

describe("user-context helpers", () => {
  it("builds a context block from recent messages", () => {
    const store = freshStore();
    store.record("34600000001", "Alice", null, "i love hiking", 50);
    const block = userContextBlock(store, "34600000001", "Alice", 20, "the person asking");
    expect(block).toContain("About Alice (the person asking)");
    expect(block).toContain('- "i love hiking"');
  });

  it("returns null when the identity is unknown", () => {
    const store = freshStore();
    expect(userContextBlock(store, "nobody", "Nobody", 20, "")).toBeNull();
  });

  it("detects a mentioned known user, excluding the asker", () => {
    const store = freshStore();
    store.record("34600000001", "Alice", null, "hi", 50);
    store.record("34600000002", "Bob", null, "yo", 50);
    const found = mentionedUsers(store, "what does bob think?", "34600000001");
    expect(found.map((u) => u.sender_key)).toEqual(["34600000002"]);
  });

  it("does not match a name embedded inside another word", () => {
    const store = freshStore();
    store.record("34600000003", "Al", null, "hi", 50);
    // "al" should not match inside "always"; also < 3 chars is skipped anyway.
    expect(mentionedUsers(store, "i always win", "someone")).toEqual([]);
  });
});
