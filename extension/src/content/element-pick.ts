// ABOUTME: Element-picker helpers — a robust CSS selector + XPath builder, a React-fiber reader that
// ABOUTME: identifies the nearest component + props, and a JSON-safe props sanitizer. Pure/defensive; never throws.
import type { PickedElement, ReactInfo } from './protocol';

const TEXT_CAP = 200;
const PROPS_JSON_CAP = 2048; // ~2KB budget for a component's serialized props
const MAX_CLASSES = 20;
const MAX_SELECTOR_DEPTH = 30;
const MAX_CHAIN = 5;

// A class/id token is "stable" (safe to lean on in a selector) when it isn't obviously machine-generated:
// css-in-js prefixes, hex hashes, React useId (":r0:"), or long digit runs all drift between renders/builds.
export function isStableToken(s: string): boolean {
  if (!s || typeof s !== 'string') return false;
  if (/^(css-|sc-|jsx-|emotion-|mui|makestyles-|chakra-|__)/i.test(s)) return false;
  if (/[0-9a-f]{6,}/i.test(s)) return false; // hex-ish hash
  if (/^:.*:$/.test(s)) return false; // React useId, e.g. ":r0:"
  if (/\d{4,}/.test(s)) return false; // long digit run (timestamps / generated ids)
  return true;
}

// A CSS identifier we can drop into a selector verbatim (letter-led, word chars/hyphen only).
function safeCssIdent(s: string): boolean {
  return /^[A-Za-z][\w-]*$/.test(s);
}

// Element's class list across representations (DOMTokenList, className string, or a fake's className).
function elementClasses(el: unknown): string[] {
  try {
    const e = el as { classList?: ArrayLike<string>; className?: unknown; getAttribute?: (n: string) => string | null };
    if (e.classList && typeof e.classList.length === 'number') return Array.from(e.classList as ArrayLike<string>);
    const raw = typeof e.className === 'string' ? e.className : e.getAttribute ? e.getAttribute('class') || '' : '';
    return String(raw).split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

type Elish = {
  nodeType: number;
  tagName: string;
  id?: string;
  parentElement?: Elish | null;
  previousElementSibling?: Elish | null;
  nextElementSibling?: Elish | null;
};

// This element's 1-based position among same-tag siblings, plus how many same-tag siblings exist total.
function siblingInfo(el: Elish): { index: number; total: number } {
  let index = 1;
  let total = 1;
  const tag = el.tagName;
  let p = el.previousElementSibling;
  while (p) {
    if (p.tagName === tag) {
      index++;
      total++;
    }
    p = p.previousElementSibling;
  }
  let n = el.nextElementSibling;
  while (n) {
    if (n.tagName === tag) total++;
    n = n.nextElementSibling;
  }
  return { index, total };
}

// One selector segment for a node: tag + a couple of stable classes, plus :nth-of-type when the node
// shares its tag with a sibling (so the segment stays unambiguous).
function segmentFor(el: Elish): string {
  const tag = el.tagName.toLowerCase();
  let seg = tag;
  const classes = elementClasses(el).filter((c) => isStableToken(c) && safeCssIdent(c)).slice(0, 3);
  if (classes.length) seg += '.' + classes.join('.');
  const { index, total } = siblingInfo(el);
  if (total > 1) seg += `:nth-of-type(${index})`;
  return seg;
}

// Build a robust CSS selector: anchor at the nearest stable id, else walk to <body>, one segment per level.
export function buildSelector(el: unknown): string {
  try {
    const start = el as Elish;
    if (!start || start.nodeType !== 1) return '';
    const parts: string[] = [];
    let node: Elish | null | undefined = start;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < MAX_SELECTOR_DEPTH) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'html') break;
      const id = node.id;
      if (id && isStableToken(id) && safeCssIdent(id)) {
        parts.unshift('#' + id); // a stable id anchors the whole path — nothing above it is needed
        break;
      }
      if (tag === 'body') {
        parts.unshift('body');
        break;
      }
      parts.unshift(segmentFor(node));
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ') || start.tagName.toLowerCase();
  } catch {
    try {
      return (el as Elish).tagName.toLowerCase();
    } catch {
      return '*';
    }
  }
}

// Positional XPath from <html> down to the element (1-based nth among same-tag siblings at each level).
export function buildXPath(el: unknown): string {
  try {
    const start = el as Elish;
    if (!start || start.nodeType !== 1) return '';
    const segs: string[] = [];
    let node: Elish | null | undefined = start;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 40) {
      const tag = node.tagName.toLowerCase();
      const { index } = siblingInfo(node);
      segs.unshift(`${tag}[${index}]`);
      if (tag === 'html') break;
      node = node.parentElement;
      depth++;
    }
    return '/' + segs.join('/');
  } catch {
    return '';
  }
}

// The display name of a fiber `type`: functions/classes expose name/displayName; memo/forwardRef/context
// wrap it in an object, so unwrap those. Host components (type is a string like "div") have no name.
function componentName(type: unknown): string | undefined {
  try {
    if (!type) return undefined;
    if (typeof type === 'string') return undefined; // host component
    if (typeof type === 'function') {
      const fn = type as { displayName?: string; name?: string };
      return fn.displayName || fn.name || undefined;
    }
    if (typeof type === 'object') {
      const o = type as { displayName?: string; render?: unknown; type?: unknown };
      if (o.displayName) return o.displayName;
      if (o.render) {
        const r = o.render as { displayName?: string; name?: string };
        return r.displayName || r.name || undefined; // forwardRef
      }
      if (o.type) return componentName(o.type); // memo
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// "file:line" from a fiber's _debugSource, when React attached one (dev builds, 16–18; gone in some 19s).
function debugSource(fiber: unknown): string | undefined {
  try {
    const src = (fiber as { _debugSource?: { fileName?: string; lineNumber?: number } })._debugSource;
    if (src && src.fileName) return src.lineNumber ? `${src.fileName}:${src.lineNumber}` : src.fileName;
  } catch {
    /* ignore */
  }
  return undefined;
}

// The React fiber key React stamps onto a DOM node: "__reactFiber$…" (16.14+/17+) or the legacy
// "__reactInternalInstance$…" (≤16.13). Scanned via own-property names so it works on real + fake nodes.
function findFiberKey(el: object): string | undefined {
  try {
    for (const k of Object.getOwnPropertyNames(el)) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) return k;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

// Best-effort React identity for a DOM node: find its fiber, walk `return` to the nearest component, and
// read its name/props/source plus a short ancestor chain. Returns undefined on any non-React node.
export function readReactInfo(el: object): ReactInfo | undefined {
  try {
    if (!el) return undefined;
    const key = findFiberKey(el);
    if (!key) return undefined;
    let fiber = (el as Record<string, unknown>)[key] as
      | { type?: unknown; return?: unknown; memoizedProps?: unknown; _debugSource?: unknown }
      | null
      | undefined;
    let component: string | undefined;
    let props: Record<string, unknown> | undefined;
    let source: string | undefined;
    const chain: string[] = [];
    let hops = 0;
    while (fiber && hops < 60) {
      const name = componentName(fiber.type);
      if (name) {
        if (!component) {
          component = name;
          props = sanitizeProps(fiber.memoizedProps);
          source = debugSource(fiber);
        }
        chain.push(name);
        if (chain.length >= MAX_CHAIN) break;
      }
      fiber = fiber.return as typeof fiber;
      hops++;
    }
    if (!component && chain.length === 0) return undefined; // fiber present but no component resolved
    const info: ReactInfo = {};
    if (component) info.component = component;
    if (props) info.props = props;
    if (source) info.source = source;
    if (chain.length) info.chain = chain;
    return info;
  } catch {
    return undefined;
  }
}

// Reduce one prop value to something JSON-safe: primitives pass through (strings capped), functions →
// "[fn]", DOM nodes → "[node <tag>]", React elements → "[element]". Objects/arrays recurse shallowly with
// a cycle guard. Depth-bounded so a deep or circular prop tree can never blow the stack.
function sanitizeValue(v: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === 'string') return (v as string).length > TEXT_CAP ? (v as string).slice(0, TEXT_CAP) + '…' : v;
  if (t === 'number' || t === 'boolean') return v;
  if (t === 'function') return '[fn]';
  if (t === 'symbol' || t === 'bigint') return String(v);
  if (t === 'object') {
    const obj = v as Record<string, unknown>;
    if (typeof (obj as { nodeType?: unknown }).nodeType === 'number') {
      const tag = (obj as { tagName?: string }).tagName;
      return tag ? `[node ${String(tag).toLowerCase()}]` : '[node]';
    }
    if ((obj as { $$typeof?: unknown }).$$typeof) return '[element]'; // React element / portal / context
    if (seen.has(obj)) return '[circular]';
    if (depth >= 2) return Array.isArray(v) ? '[array]' : '[object]'; // shallow — don't deep-walk
    seen.add(obj);
    try {
      if (Array.isArray(v)) return v.slice(0, 20).map((x) => sanitizeValue(x, depth + 1, seen));
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(obj).slice(0, 40)) out[k] = sanitizeValue(obj[k], depth + 1, seen);
      return out;
    } finally {
      seen.delete(obj);
    }
  }
  return String(v);
}

// Sanitize a component's props object into a JSON-safe, size-capped map. `children` is elided (it holds
// React nodes, not data). Keys are added until the serialized size crosses the cap, then `__truncated`.
export function sanitizeProps(props: unknown, cap = PROPS_JSON_CAP): Record<string, unknown> | undefined {
  try {
    if (!props || typeof props !== 'object') return undefined;
    const seen = new WeakSet<object>();
    const out: Record<string, unknown> = {};
    let approx = 2; // "{}"
    for (const k of Object.keys(props as Record<string, unknown>)) {
      const value = k === 'children' ? '[children]' : sanitizeValue((props as Record<string, unknown>)[k], 0, seen);
      let piece = '';
      try {
        piece = JSON.stringify({ [k]: value }) ?? '';
      } catch {
        piece = '';
      }
      if (approx + piece.length > cap) {
        out.__truncated = true;
        break;
      }
      out[k] = value;
      approx += piece.length;
    }
    return out;
  } catch {
    return undefined;
  }
}

// Trimmed, whitespace-collapsed, capped visible text of an element (best-effort).
function elementText(el: unknown): string | undefined {
  try {
    const raw = (el as { textContent?: unknown }).textContent;
    if (typeof raw !== 'string') return undefined;
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t) return undefined;
    return t.length > TEXT_CAP ? t.slice(0, TEXT_CAP) : t;
  } catch {
    return undefined;
  }
}

// Compose the full PickedElement record for a live DOM element (selector/xpath/text/rect/react). DOM-coupled
// (getBoundingClientRect); the pure sub-builders above are what carry the unit tests. Never throws.
export function describeElement(el: Element): PickedElement {
  const tag = (el.tagName || '').toLowerCase();
  let rect = { x: 0, y: 0, w: 0, h: 0 };
  try {
    const r = el.getBoundingClientRect();
    rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  } catch {
    /* keep the zero rect */
  }
  const classes = elementClasses(el).slice(0, MAX_CLASSES);
  const id = el.id ? String(el.id) : undefined;
  const picked: PickedElement = { selector: buildSelector(el), tag, rect };
  const xpath = buildXPath(el);
  if (xpath) picked.xpath = xpath;
  if (id) picked.id = id;
  if (classes.length) picked.classes = classes;
  const text = elementText(el);
  if (text) picked.text = text;
  const react = readReactInfo(el);
  if (react) picked.react = react;
  return picked;
}
