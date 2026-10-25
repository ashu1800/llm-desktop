import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex h-full min-h-[320px] flex-col items-center justify-center gap-3.5 rounded-2xl border border-dashed border-border/80 bg-muted/15 p-10 text-center transition-colors",
        className
      )}
    >
      <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/60 shadow-xs ring-1 ring-border/80">
        <Icon className="h-7 w-7 text-muted-foreground/75" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold tracking-tight text-foreground">{title}</p>
        <p className="max-w-md text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
