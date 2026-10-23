import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  milestone?: string;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  milestone,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex h-full min-h-[320px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-muted/20 p-10 text-center",
        className
      )}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Icon className="h-6 w-6 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      </div>
      {milestone && (
        <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          计划于 {milestone} 落地
        </span>
      )}
    </div>
  );
}
