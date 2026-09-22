// adb.ts — the one place a subprocess is spawned.

export const ADB = process.env.DROIDREAD_ADB ?? process.env.DROIDCAST_ADB ?? "adb";

export async function adb(...args: string[]): Promise<string> {
  const p = Bun.spawn([ADB, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

export const tap = (x: number, y: number) => adb("shell", "input", "tap", String(x), String(y));
export const back = () => adb("shell", "input", "keyevent", "KEYCODE_BACK");
export const wake = () => adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");

/** Scroll toward OLDER messages (content moves down). */
export const swipeUp = (ms = 250) => adb("shell", "input", "swipe", "540", "600", "540", "2000", String(ms));
/** Scroll toward NEWER messages. */
export const swipeDown = (ms = 250) => adb("shell", "input", "swipe", "540", "1800", "540", "700", String(ms));

export async function devices(): Promise<string[]> {
  const out = await adb("devices");
  return out.split("\n").slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith("*"));
}
