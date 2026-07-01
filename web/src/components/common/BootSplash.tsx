// ABOUTME: Calm boot state shown while the session is being resolved.
import { BrandTile, Wordmark } from "./Brandmark";

export function BootSplash() {
  return (
    <div className="grid h-full place-items-center bg-background">
      <div className="flex flex-col items-center gap-4 soft-fade">
        <BrandTile className="size-11 animate-pulse" />
        <Wordmark className="text-lg" />
      </div>
    </div>
  );
}
