// ABOUTME: Lists the elements a QA reporter picked on the page — selector identity, text, geometry, and the
// ABOUTME: owning React component (name/props/source/chain). Hover highlights it over the stage; empty ⇒ null.
import { memo, useState } from "react";
import { ChevronRight, Component, Crosshair } from "lucide-react";
import type { PickedElement } from "@/lib/types";
import { cn } from "@/lib/utils";

/** `button#submit.btn.primary` — the compact CSS-ish identity for a picked node's header line. */
function identityOf(el: PickedElement): string {
  const id = el.id ? `#${el.id}` : "";
  const classes = el.classes && el.classes.length > 0 ? `.${el.classes.join(".")}` : "";
  return `${el.tag.toLowerCase()}${id}${classes}`;
}

/** JSON-stringify a prop value onto a single line for the tree, tolerating cyclic / unserializable values. */
function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "function") return "ƒ()";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function PickedElements({
  elements,
  activeIndex,
  onActivate,
  selectedIndex = null,
  onSelect,
}: {
  elements: PickedElement[];
  /** The row currently hovered — a transient highlight over the stage (via the stored page rect). */
  activeIndex: number | null;
  onActivate: (index: number | null) => void;
  /** The row the reporter clicked — a persistent selection that seeks the replay + highlights it live. */
  selectedIndex?: number | null;
  /** Click a row: seek the player to the element's captured moment and highlight it in the replay. */
  onSelect?: (index: number) => void;
}) {
  if (elements.length === 0) return null;
  return (
    <div className="rounded-lg border border-border/60 bg-background p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <Crosshair className="size-3.5" style={{ color: "var(--status-in_progress)" }} />
        <h3 className="text-[12px] font-semibold text-foreground">Picked elements</h3>
        <span className="text-[11px] text-muted-foreground">{elements.length}</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {elements.map((el, i) => (
          <PickRow
            key={`${el.selector}-${i}`}
            el={el}
            active={activeIndex === i}
            selected={selectedIndex === i}
            onHover={(on) => onActivate(on ? i : null)}
            onSelect={onSelect ? () => onSelect(i) : undefined}
          />
        ))}
      </ul>
    </div>
  );
}

const PickRow = memo(function PickRow({
  el,
  active,
  selected,
  onHover,
  onSelect,
}: {
  el: PickedElement;
  active: boolean;
  selected: boolean;
  onHover: (on: boolean) => void;
  onSelect?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const propEntries = el.react?.props ? Object.entries(el.react.props) : [];
  const hasDetail =
    !!el.react?.component || propEntries.length > 0 || !!el.react?.source || !!el.react?.chain?.length;

  return (
    <li
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      className={cn(
        "rounded-md border transition-colors",
        selected
          ? "border-primary/60 bg-primary/[0.07] ring-1 ring-primary/30"
          : active
            ? "border-primary/50 bg-primary/[0.05]"
            : "border-border/50 bg-card",
      )}
    >
      <button
        type="button"
        // Clicking a row seeks the replay to this element's moment + highlights it live; if it also carries
        // React detail, toggle that disclosure too.
        onClick={() => {
          onSelect?.();
          if (hasDetail) setOpen((o) => !o);
        }}
        aria-expanded={hasDetail ? open : undefined}
        className="flex w-full cursor-pointer items-start gap-1.5 px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {hasDetail ? (
          <ChevronRight
            className={cn("mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
          />
        ) : (
          <span className="mt-0.5 size-3 shrink-0" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <code className="min-w-0 break-all font-mono text-[11.5px] font-medium text-foreground" title={el.selector}>
              {identityOf(el)}
            </code>
            {el.react?.component && (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                <Component className="size-2.5" style={{ color: "var(--status-in_progress)" }} />
                {el.react.component}
              </span>
            )}
          </span>
          {el.text && (
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground" title={el.text}>
              “{el.text}”
            </span>
          )}
          <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground/70">
            {Math.round(el.rect.w)}×{Math.round(el.rect.h)} @ {Math.round(el.rect.x)},{Math.round(el.rect.y)}
          </span>
        </span>
      </button>

      {open && hasDetail && (
        <div className="space-y-2 border-t border-border/40 px-2 py-2">
          {propEntries.length > 0 && (
            <div>
              <p className="mb-1 text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                Props
              </p>
              <dl className="space-y-0.5">
                {propEntries.map(([k, v]) => (
                  <div key={k} className="flex gap-1.5 text-[10.5px]">
                    <dt className="shrink-0 font-mono font-medium text-primary/80">{k}</dt>
                    <dd className="min-w-0 break-all font-mono text-muted-foreground" title={formatValue(v)}>
                      {formatValue(v)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {el.react?.source && (
            <div className="text-[10.5px]">
              <span className="font-semibold uppercase tracking-wide text-muted-foreground/80">Source </span>
              <code className="break-all font-mono text-muted-foreground">{el.react.source}</code>
            </div>
          )}
          {el.react?.chain && el.react.chain.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-[10.5px] text-muted-foreground">
              {el.react.chain.map((name, i) => (
                <span key={`${name}-${i}`} className="inline-flex items-center gap-1">
                  {i > 0 && <span className="text-muted-foreground/50">›</span>}
                  <code className="font-mono">{name}</code>
                </span>
              ))}
            </div>
          )}
          {el.xpath && (
            <div className="text-[10.5px]">
              <span className="font-semibold uppercase tracking-wide text-muted-foreground/80">XPath </span>
              <code className="break-all font-mono text-muted-foreground">{el.xpath}</code>
            </div>
          )}
        </div>
      )}
    </li>
  );
});
