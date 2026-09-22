// Structure, not appearance: these pin the two properties the renderer must have.

import { expect, test } from "bun:test";
import { snapshot } from "../src/snapshot.ts";
import type { Node } from "../src/tree.ts";

const node = (p: Partial<Node> & { x1: number; y1: number; x2: number; y2: number }): Node => ({
  id: "", cls: "ViewGroup", text: "", desc: "", clickable: false,
  x: Math.round((p.x1 + p.x2) / 2), y: Math.round((p.y1 + p.y2) / 2), ...p,
});

// A Settings row: a clickable group whose title sits ABOVE the group's own centre.
// Sorting rows by centre y used to print the title before its parent, so the title read
// as part of the row above it.
const settingsRow = [
  node({ cls: "RecyclerView", id: "recycler_view", x1: 0, y1: 100, x2: 1080, y2: 900 }),
  node({ cls: "ViewGroup", clickable: true, x1: 0, y1: 400, x2: 1080, y2: 600 }),
  node({ cls: "TextView", id: "title", text: "Device care", x1: 40, y1: 410, x2: 500, y2: 460 }),
  node({ cls: "TextView", id: "summary", text: "Storage", x1: 40, y1: 520, x2: 700, y2: 570 }),
];

test("a child never renders before its parent", () => {
  const lines = snapshot(settingsRow).split("\n");
  const group = lines.findIndex((l) => l.includes("group") && l.includes("clickable"));
  const title = lines.findIndex((l) => l.includes("Device care"));
  expect(group).toBeGreaterThanOrEqual(0);
  expect(title).toBeGreaterThan(group);
  expect(lines[title]!.indexOf("-")).toBeGreaterThan(lines[group]!.indexOf("-"));
});

test("a node with children ends in a colon", () => {
  const out = snapshot(settingsRow);
  expect(out).toContain("clickable]:");
});

test("rendering is idempotent", () => {
  expect(snapshot(settingsRow)).toBe(snapshot(settingsRow));
});

test("silent single-child wrappers collapse away", () => {
  const wrapped = [
    node({ cls: "FrameLayout", x1: 0, y1: 0, x2: 1080, y2: 400 }),
    node({ cls: "LinearLayout", x1: 10, y1: 10, x2: 1070, y2: 390 }),
    node({ cls: "Button", text: "Save", clickable: true, x1: 20, y1: 20, x2: 1060, y2: 380 }),
  ];
  const lines = snapshot(wrapped).split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('button "Save"');
});

test("refs are handed out only to actionable elements", () => {
  const out = snapshot(settingsRow, { refs: true });
  expect(out).toContain("ref=e1");
  expect(out.match(/ref=/g)).toHaveLength(1);   // the group, not its two labels
});
