// ABOUTME: The be10x brand mark — an orange tile with a small ascending-columns glyph (the board motif),
// beside the wordmark. Clicking the tile is wired up by the caller (used to re-expand the sidebar).
import { cn } from "@/lib/utils";

export function BrandTile({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-[8px] bg-primary text-primary-foreground shadow-[0_2px_8px_rgba(232,98,13,0.35)]",
        className,
      )}
      aria-hidden
    >
      <svg width="17" height="17" viewBox="0 0 20 20" fill="none">
        <rect x="2.5" y="10.5" width="3.6" height="7" rx="1.4" fill="currentColor" />
        <rect x="8.2" y="6" width="3.6" height="11.5" rx="1.4" fill="currentColor" opacity="0.85" />
        <rect x="13.9" y="2.5" width="3.6" height="15" rx="1.4" fill="currentColor" opacity="0.7" />
      </svg>
    </span>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("text-[15px] font-extrabold tracking-tight text-foreground", className)}>
      be<span className="text-primary">10x</span>
    </span>
  );
}
