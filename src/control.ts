// control.ts — the write half: tap, swipe, type, keys.
//
// SAFETY, deliberate and non-negotiable in the design:
//
//  1. Control is OPT-IN. Set DROIDREAD_ALLOW_CONTROL=1. Reading a phone is harmless;
//     tapping inside a live messaging app can send, forward, react or delete, and an
//     LLM driving it should not be one stray call away from that by default.
//  2. Taps are SELECTOR-based, never raw coordinates. A coordinate that was correct one
//     scroll ago lands somewhere else entirely — this exact bug opened the wrong
//     conversation during development.
//  3. Ambiguity is an error. Two matches means refuse, not pick the first.

import { adb, tap as tapXY } from "./adb.ts";
import { dump, match, resolveOne, type Node, type Selector } from "./tree.ts";

export class ControlDisabled extends Error {
  constructor() {
    super("control is disabled — set DROIDREAD_ALLOW_CONTROL=1 to allow taps, typing and key events");
    this.name = "ControlDisabled";
  }
}

export function assertControlAllowed(): void {
  if (process.env.DROIDREAD_ALLOW_CONTROL !== "1") throw new ControlDisabled();
}

export interface FoundEl {
  role: string; name: string; id: string; clickable: boolean;
  x: number; y: number; bounds: [number, number, number, number];
}

const describe = (n: Node): FoundEl => ({
  role: n.cls, name: n.text || n.desc, id: n.id, clickable: n.clickable,
  x: n.x, y: n.y, bounds: [n.x1, n.y1, n.x2, n.y2],
});

/** Query elements without touching anything — the "get element" half of two-way. */
export async function query(sel: Selector, nodes?: Node[]): Promise<FoundEl[]> {
  return match(nodes ?? (await dump()), sel).map(describe);
}

/** Tap the single element matching sel, or throw. */
export async function tapSelector(sel: Selector): Promise<FoundEl> {
  assertControlAllowed();
  const node = resolveOne(await dump(), sel);
  await tapXY(node.x, node.y);
  await Bun.sleep(1200);
  return describe(node);
}

export type Dir = "up" | "down" | "left" | "right";

export async function swipe(dir: Dir, ms = 250): Promise<void> {
  assertControlAllowed();
  const moves: Record<Dir, [string, string, string, string]> = {
    up:    ["540", "600",  "540", "2000"],   // reveals OLDER content
    down:  ["540", "1800", "540", "700"],
    left:  ["900", "1200", "200", "1200"],
    right: ["200", "1200", "900", "1200"],
  };
  await adb("shell", "input", "swipe", ...moves[dir], String(ms));
  await Bun.sleep(700);
}

export async function pressKey(key: "back" | "home" | "enter" | "wake"): Promise<void> {
  assertControlAllowed();
  const codes = { back: "KEYCODE_BACK", home: "KEYCODE_HOME", enter: "KEYCODE_ENTER", wake: "KEYCODE_WAKEUP" };
  await adb("shell", "input", "keyevent", codes[key]);
  await Bun.sleep(800);
}

/**
 * Type into the focused field.
 *
 * LIMITATION, stated rather than discovered later: `input text` handles ASCII only.
 * Thai, emoji and other non-ASCII need an IME such as ADBKeyboard installed and selected;
 * without it those characters are silently dropped, so this refuses them outright.
 */
export async function typeText(s: string): Promise<void> {
  assertControlAllowed();
  if (!/^[\x20-\x7E]*$/.test(s)) {
    throw new Error("non-ASCII text needs an IME (e.g. ADBKeyboard); refusing to type it silently mangled");
  }
  await adb("shell", "input", "text", s.replace(/ /g, "%s"));
  await Bun.sleep(600);
}

// ---------------------------------------------------------------------------
// Launching apps and settings screens.
//
// WHY THIS IS NOT A SEQUENCE OF TAPS: getting to a settings screen by pressing home,
// opening the launcher, scrolling for an icon and tapping it is many fragile steps that
// depend on the launcher's layout and the device's language. `am start` with a documented
// intent action is one step and works the same on every Android.
//
// It counts as control and is gated like the rest: it changes what is on the screen, and
// an agent that can open Settings can open anything.
// ---------------------------------------------------------------------------

/** Documented Settings shortcuts, so a caller does not have to remember the action strings. */
export const SETTINGS_SCREENS: Record<string, string> = {
  settings: "android.settings.SETTINGS",
  developer: "android.settings.APPLICATION_DEVELOPMENT_SETTINGS",
  display: "android.settings.DISPLAY_SETTINGS",
  wifi: "android.settings.WIFI_SETTINGS",
  bluetooth: "android.settings.BLUETOOTH_SETTINGS",
  battery: "android.settings.BATTERY_SAVER_SETTINGS",
  apps: "android.settings.APPLICATION_SETTINGS",
  accessibility: "android.settings.ACCESSIBILITY_SETTINGS",
  date: "android.settings.DATE_SETTINGS",
  storage: "android.settings.INTERNAL_STORAGE_SETTINGS",
  security: "android.settings.SECURITY_SETTINGS",
  about: "android.settings.DEVICE_INFO_SETTINGS",
};

export interface Launched { via: "screen" | "action" | "package"; target: string; focus: string }

/** What window currently has focus — the honest check that a launch actually landed. */
export async function currentFocus(): Promise<string> {
  const out = await adb("shell", "dumpsys window");
  const line = out.split("\n").find((l) => l.includes("mCurrentFocus")) ?? "";
  return line.split("=").slice(1).join("=").trim().replace(/^Window\{[^ ]+ u0 /, "").replace(/\}$/, "") || "(unknown)";
}

/**
 * Open a settings screen by short name, an intent action, or an app by package.
 * Verifies with the focused window rather than trusting `am start`, which reports success
 * for an activity it merely brought to the front.
 */
export async function openScreen(target: string): Promise<Launched> {
  assertControlAllowed();
  const key = target.trim().toLowerCase();

  let via: Launched["via"], out: string;
  if (SETTINGS_SCREENS[key]) {
    via = "screen";
    out = await adb("shell", "am", "start", "-a", SETTINGS_SCREENS[key]!);
  } else if (target.includes(".") && !target.includes("/") && target.startsWith("android.settings.")) {
    via = "action";
    out = await adb("shell", "am", "start", "-a", target);
  } else if (target.includes(".")) {
    via = "package";
    out = await adb("shell", "monkey", "-p", target, "-c", "android.intent.category.LAUNCHER", "1");
  } else {
    throw new Error(
      `unknown target ${JSON.stringify(target)} — use one of: ${Object.keys(SETTINGS_SCREENS).join(", ")}, ` +
      `an android.settings.* action, or a package name like com.facebook.orca`,
    );
  }

  if (/Error|Exception|No activities found/i.test(out)) {
    throw new Error(`launch failed for ${target}: ${out.trim().split("\n")[0]}`);
  }
  await Bun.sleep(1500);
  return { via, target, focus: await currentFocus() };
}
