// snapshot.ts — the screen as readable text, in the spirit of Playwright's ariaSnapshot.
//
// Screenshots need eyes and cost megabytes; raw uiautomator XML is unreadable. This is the
// middle ground a human AND a model can both read, diff, and quote selectors from.
//
// THE HARD PART IS THAT THERE IS NO TREE. `uiautomator dump` gives a flat list of nodes
// with bounds, so the hierarchy has to be recovered from geometry: a node's parent is the
// smallest node that strictly contains it.
//
// An earlier version approximated this by counting containers and then sorting every row
// by its centre y, which quietly produced wrong structure. A Settings row is a clickable
// group containing a title and a summary, and the title's centre sits ABOVE the group's
// centre — so the child was printed before its own parent, and every row's title appeared
// to belong to the row above it. Build the tree first, then walk it; never sort a flat
// list and hope it reads as a hierarchy.

import { dump, type Node } from "./tree.ts";

const ROLE: Record<string, string> = {
  Button: "button", ImageButton: "button", TextView: "text", EditText: "textbox",
  ImageView: "img", CheckBox: "checkbox", Switch: "switch", RecyclerView: "list",
  ListView: "list", ScrollView: "scrollable", HorizontalScrollView: "scrollable",
  ViewGroup: "group", FrameLayout: "group", LinearLayout: "group", RelativeLayout: "group",
  View: "generic", WebView: "document", ProgressBar: "progressbar", SeekBar: "slider",
  RadioButton: "radio", Spinner: "combobox", TabWidget: "tablist", ToggleButton: "switch",
};

interface TreeNode { node: Node; children: TreeNode[] }

const area = (n: Node) => Math.max(0, n.x2 - n.x1) * Math.max(0, n.y2 - n.y1);
const contains = (p: Node, c: Node) =>
  p.x1 <= c.x1 && p.y1 <= c.y1 && p.x2 >= c.x2 && p.y2 >= c.y2 && area(p) > area(c);

/** Recover the hierarchy from bounds: parent = smallest strictly-containing node. */
function buildTree(keep: Node[]): TreeNode[] {
  // Largest first, so by the time a node is placed every possible parent already exists.
  const bySize = [...keep].sort((a, b) => area(b) - area(a));
  const placed: TreeNode[] = [];
  const roots: TreeNode[] = [];

  for (const n of bySize) {
    const tn: TreeNode = { node: n, children: [] };
    let parent: TreeNode | null = null;
    for (const p of placed) {
      if (contains(p.node, n) && (!parent || area(p.node) < area(parent.node))) parent = p;
    }
    (parent ? parent.children : roots).push(tn);
    placed.push(tn);
  }

  // Reading order within a parent: top to bottom, then left to right.
  const order = (list: TreeNode[]) => {
    list.sort((a, b) => a.node.y1 - b.node.y1 || a.node.x1 - b.node.x1);
    for (const t of list) order(t.children);
  };
  order(roots);
  return roots;
}

const named = (n: Node) => n.text || n.desc;

/** A wrapper that says nothing and wraps one thing is noise; splice it out. */
function collapse(list: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const t of list) {
    t.children = collapse(t.children);
    const silent = !named(t.node) && !t.node.id && !t.node.clickable;
    if (silent && t.children.length === 1) { out.push(t.children[0]!); continue; }
    if (silent && t.children.length === 0) continue;   // an empty invisible box
    out.push(t);
  }
  return out;
}

function line(n: Node, maxName: number): string {
  const role = ROLE[n.cls] ?? n.cls.toLowerCase();
  const name = named(n);
  const bits = [role];
  if (name) bits.push(JSON.stringify(name.length > maxName ? name.slice(0, maxName) + "…" : name));
  const attrs: string[] = [];
  if (n.id) attrs.push(`#${n.id}`);
  if (n.clickable) attrs.push("clickable");
  if (attrs.length) bits.push(`[${attrs.join(" ")}]`);
  bits.push(`@${n.x},${n.y}`);
  return bits.join(" ");
}

function render(list: TreeNode[], depth: number, maxName: number, out: string[]): void {
  for (const t of list) {
    const pad = "  ".repeat(depth);
    // Playwright's convention: a node with children ends in ":" and nests beneath.
    out.push(`${pad}- ${line(t.node, maxName)}${t.children.length ? ":" : ""}`);
    render(t.children, depth + 1, maxName, out);
  }
}

export function snapshot(nodes: Node[], opts: { all?: boolean; maxName?: number } = {}): string {
  const keep = nodes.filter((n) =>
    opts.all || n.text || n.desc || n.clickable ||
    ["RecyclerView", "ListView", "ScrollView", "EditText"].includes(n.cls),
  );
  const tree = opts.all ? buildTree(keep) : collapse(buildTree(keep));
  const out: string[] = [];
  render(tree, 0, opts.maxName ?? 70, out);
  return out.join("\n");
}

/**
 * Every distinct label on screen, in reading order — the flat view, for "what are my
 * options here" rather than "how is this screen built". Rows that carry a summary under a
 * title are joined so one line is one choice.
 */
export function labels(nodes: Node[]): { name: string; summary: string; clickable: boolean; x: number; y: number }[] {
  const keep = nodes.filter((n) => n.text || n.desc);
  const tree = collapse(buildTree(keep.concat(nodes.filter((n) => n.clickable))));
  const rows: { name: string; summary: string; clickable: boolean; x: number; y: number }[] = [];

  const walk = (list: TreeNode[]) => {
    for (const t of list) {
      const texts: Node[] = [];
      const gather = (x: TreeNode) => { if (named(x.node)) texts.push(x.node); x.children.forEach(gather); };
      gather(t);
      if (t.node.clickable && texts.length) {
        texts.sort((a, b) => a.y1 - b.y1);
        rows.push({
          name: named(texts[0]!),
          summary: texts.slice(1).map(named).join(" · "),
          clickable: true, x: t.node.x, y: t.node.y,
        });
        continue;   // the row is the unit; do not also list its parts
      }
      if (named(t.node) && !t.children.length) {
        rows.push({ name: named(t.node), summary: "", clickable: t.node.clickable, x: t.node.x, y: t.node.y });
      }
      walk(t.children);
    }
  };
  walk(tree);

  const seen = new Set<string>();
  return rows.filter((r) => { const k = `${r.name}|${r.y}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export async function screenSnapshot(opts: { all?: boolean; maxName?: number } = {}): Promise<string> {
  return snapshot(await dump(), opts);
}
