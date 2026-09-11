"use client";

import type React from "react";
import { cn } from "@/lib/utils";

export function Skeleton({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-sm bg-muted",
        "after:absolute after:inset-0 after:-translate-x-full after:animate-[skeleton-shimmer_2s_infinite] after:bg-gradient-to-r after:from-transparent after:via-foreground/10 after:to-transparent",
        className,
      )}
      data-slot="skeleton"
      {...props}
    />
  );
}

export default Skeleton;
