// ABOUTME: Animated brand-mark tiles built on @paper-design/shaders-react. `BrandShader` renders one
// WebGL shader as a small rounded logo tile; `ShaderShowcase` previews all five variants so a human
// can pick one. Honours prefers-reduced-motion by freezing the shader on a still frame (speed 0).
import { useEffect, useState } from "react";
import { Dithering, MeshGradient, SmokeRing, Warp } from "@paper-design/shaders-react";
import { cn } from "@/lib/utils";

export type BrandShaderVariant = "ring-warp" | "heatmap" | "smoke-ring" | "aurora" | "dithering";

const VARIANTS: { variant: BrandShaderVariant; label: string }[] = [
  { variant: "ring-warp", label: "Ring Warp" },
  { variant: "heatmap", label: "Heatmap" },
  { variant: "smoke-ring", label: "Smoke Ring" },
  { variant: "aurora", label: "Aurora" },
  { variant: "dithering", label: "Dithering" },
];

/** Tracks the user's `prefers-reduced-motion` setting so we can freeze the shaders when asked. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

// The shader components each render a <div> that mounts a canvas matching the div's box. Filling the
// parent tile lets a single BrandShader scale from a 36px logo to a 120px showcase cell via className.
const fill = { width: "100%", height: "100%", display: "block" } as const;

/** Maps a brand variant to a paper-design shader with a fitting palette. `animated` is false when the
 *  user prefers reduced motion, in which case every shader is pinned to speed 0 (a static frame). */
function renderShader(variant: BrandShaderVariant, animated: boolean) {
  switch (variant) {
    // Indigo -> amber warp with a strong swirl so the bands read as a warped ring.
    case "ring-warp":
      return (
        <Warp
          style={fill}
          speed={animated ? 1 : 0}
          colors={["#312e81", "#4f46e5", "#f59e0b", "#fcd34d"]}
          proportion={0.4}
          softness={1}
          distortion={0.2}
          swirl={0.85}
          swirlIterations={10}
          shape="stripes"
        />
      );
    // Red / orange / yellow mesh over a deep-red base for a thermal "heatmap" feel.
    case "heatmap":
      return (
        <MeshGradient
          style={fill}
          speed={animated ? 0.6 : 0}
          colors={["#7f1d1d", "#ef4444", "#f97316", "#fde047"]}
          distortion={0.85}
          swirl={0.6}
          grainOverlay={0.06}
        />
      );
    // Soft pale halo: a near-white ring with a faint lavender edge on a light backdrop.
    case "smoke-ring":
      return (
        <SmokeRing
          style={fill}
          speed={animated ? 0.5 : 0}
          colorBack="#eef2f7"
          colors={["#ffffff", "#dbe2ea", "#c7d2fe"]}
          thickness={0.4}
          radius={0.5}
        />
      );
    // Violet / blue / teal spots over a night base — an aurora over a dark sky.
    case "aurora":
      return (
        <MeshGradient
          style={fill}
          speed={animated ? 0.7 : 0}
          colors={["#0b1220", "#7c3aed", "#2563eb", "#14b8a6"]}
          distortion={0.9}
          swirl={0.55}
        />
      );
    // A two-tone dithered gradient (indigo ink on a near-black ground).
    case "dithering":
      return (
        <Dithering
          style={fill}
          speed={animated ? 0.6 : 0}
          colorBack="#0b1220"
          colorFront="#818cf8"
          shape="warp"
          type="4x4"
          size={2}
        />
      );
  }
}

/** A single animated brand tile (~36px by default; override the size via `className`). */
export function BrandShader({
  variant,
  className,
}: {
  variant: BrandShaderVariant;
  className?: string;
}) {
  const animated = !usePrefersReducedMotion();
  return (
    <span
      className={cn(
        "relative block size-9 shrink-0 overflow-hidden rounded-xl bg-muted",
        className,
      )}
      aria-hidden
    >
      {renderShader(variant, animated)}
    </span>
  );
}

/** Preview grid of every variant (~120px tiles, name below) for picking a brand mark. */
export function ShaderShowcase() {
  return (
    <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 md:grid-cols-5">
      {VARIANTS.map(({ variant, label }) => (
        <figure key={variant} className="flex flex-col items-center gap-2">
          <BrandShader variant={variant} className="size-[120px] rounded-2xl" />
          <figcaption className="text-xs font-medium text-muted-foreground">{label}</figcaption>
        </figure>
      ))}
    </div>
  );
}
