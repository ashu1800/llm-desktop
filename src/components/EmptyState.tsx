import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  className?: string;
  children?: React.ReactNode;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  className,
  children,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex h-full min-h-[240px] flex-col items-center justify-center gap-3.5 rounded-2xl border border-dashed border-border/80 bg-muted/15 p-8 text-center transition-colors",
        className,
      )}
    >
      <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl bg-muted/60 shadow-xs ring-1 ring-border/80">
        <Icon className="h-6 w-6 text-muted-foreground/75" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold tracking-tight text-foreground">{title}</p>
        <p className="max-w-md text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {children && <div className="mt-1 flex items-center justify-center gap-2">{children}</div>}
    </div>
  );
}
