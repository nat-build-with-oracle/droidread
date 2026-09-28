// resolve-chat.test.ts — read-side tools take a SUBSTRING of the chat name, but rows are
// keyed by the exact name they were indexed under. Before resolveChat, "Team" against
// "Team Chat" matched nothing and droidread_since said "0 of 0 indexed".
// Run: bun test

import { beforeAll, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { migrate } from "../src/migrate.ts";
import { insertMessages, messagesSince, resolveChat } from "../src/db.ts";

const db = createClient({ url: ":memory:" });

beforeAll(async () => {
  await migrate(db);
  await insertMessages(db, "messenger", "Team Chat", [
    { sender: "Ann", text: "morning", sentAt: "2026-09-24 09:00:00", sentAtRaw: "09:00" },
    { sender: "Bo", text: "no divider above me" },
  ]);
  await insertMessages(db, "messenger", "Team Chat Archive", [{ sender: "Cy", text: "old news" }]);
  await insertMessages(db, "messenger", "Family", [{ sender: "Di", text: "dinner?" }]);
  await insertMessages(db, "line", "Team", [{ sender: "Ed", text: "a LINE chat" }]);
});

test("the reported bug: a substring now reaches the indexed rows", async () => {
  const name = await resolveChat(db, "messenger", "Archive");
  expect(name).toBe("Team Chat Archive");
  const { total } = await messagesSince(db, "messenger", await resolveChat(db, "messenger", "Family"), "2026-01-01 00:00");
  expect(total).toBe(1);
});

test("an exact name wins even when it is a substring of another chat", async () => {
  expect(await resolveChat(db, "messenger", "Team Chat")).toBe("Team Chat");
});

test("substring matching ignores case", async () => {
  expect(await resolveChat(db, "messenger", "family")).toBe("Family");
});

test("an ambiguous substring is refused and names every candidate", async () => {
  await expect(resolveChat(db, "messenger", "team")).rejects.toThrow(
    '"team" matches 2 indexed messenger chats — pass one exactly: "Team Chat", "Team Chat Archive"',
  );
});

test("no match says so, instead of looking like an empty chat", async () => {
  await expect(resolveChat(db, "messenger", "Work")).rejects.toThrow('no indexed messenger chat matches "Work"');
});

test("another app's chats are never candidates", async () => {
  expect(await resolveChat(db, "line", "team")).toBe("Team");
  await expect(resolveChat(db, "whatsapp", "Team")).rejects.toThrow("no whatsapp chat indexed yet");
});

test("an empty name is refused rather than matching everything", async () => {
  await expect(resolveChat(db, "line", "  ")).rejects.toThrow("chat name is empty");
});
