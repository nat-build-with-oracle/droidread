// snapshot.ts — the screen as readable text, in the spirit of Playwright's ariaSnapshot.
//
// Screenshots need eyes and cost megabytes; raw uiautomator XML is unreadable. This is
// the middle ground a human AND a model can both read, diff, and quote selectors from.

import { dump, type Node } from "./tree.ts";

const ROLE: Record<string, string> = {
  Button: "button", ImageButton: "button", TextView: "text", EditText: "textbox",
  ImageView: "img", CheckBox: "checkbox", Switch: "switch", RecyclerView: "list",
  ListView: "list", ScrollView: "scrollable", ViewGroup: "group", FrameLayout: "group",
  LinearLayout: "group", RelativeLayout: "group", View: "generic",
};

/** Nesting from geometric containment — uiautomator's flat dump has no parent pointers. */
function depthOf(n: Node, within: Node[]): number {
  const area = (m: Node) => (m.x2 - m.x1) * (m.y2 - m.y1);
  return within.filter((m) =>
    m !== n && m.x1 <= n.x1 && m.y1 <= n.y1 && m.x2 >= n.x2 && m.y2 >= n.y2 && area(m) > area(n)
  ).length;
}

export function snapshot(nodes: Node[], opts: { all?: boolean } = {}): string {
  const keep = nodes.filter((n) =>
    opts.all || n.text || n.desc || n.clickable ||
    ["RecyclerView", "ListView", "ScrollView", "EditText"].includes(n.cls),
  );

  // Depth must be measured against KEEP, not the raw dump. Counting containment against
  // filtered-out layout wrappers makes depth climb without bound — four sibling avatars
  // in one row end up at four different indent levels.
  const rows = keep.map((n) => {
    const role = ROLE[n.cls] ?? n.cls.toLowerCase();
    const name = n.text || n.desc;
    const bits: string[] = [role];
    if (name) bits.push(JSON.stringify(name.length > 70 ? name.slice(0, 70) + "…" : name));
    const attrs: string[] = [];
    if (n.id) attrs.push(`#${n.id}`);
    if (n.clickable) attrs.push("clickable");
    if (!name && !n.clickable && !n.id) attrs.push("empty");
    if (attrs.length) bits.push(`[${attrs.join(" ")}]`);
    bits.push(`@${n.x},${n.y}`);
    return { depth: depthOf(n, keep), line: bits.join(" "), y: n.y };
  });

  rows.sort((a, b) => a.y - b.y || a.depth - b.depth);
  const minDepth = rows.length ? Math.min(...rows.map((r) => r.depth)) : 0;
  return rows.map((r) => "  ".repeat(Math.max(0, r.depth - minDepth)) + "- " + r.line).join("\n");
}

export async function screenSnapshot(opts: { all?: boolean } = {}): Promise<string> {
  return snapshot(await dump(), opts);
}
