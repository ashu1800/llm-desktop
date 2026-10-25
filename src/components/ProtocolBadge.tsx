import { cn } from "@/lib/utils";
import type { UpstreamProto } from "@/lib/types";

interface ProtocolBadgeProps {
  protocol: UpstreamProto | string;
  className?: string;
  /** 是否展示小圆点前缀 (默认 true) */
  dot?: boolean;
}

const PROTOCOL_CONFIG: Record<
  string,
  { label: string; bg: string; text: string; border: string; dot: string }
> = {
  openai: {
    label: "OpenAI",
    bg: "bg-emerald-500/10 dark:bg-emerald-500/15",
    text: "text-emerald-700 dark:text-emerald-400",
    border: "border-emerald-500/25 dark:border-emerald-500/30",
    dot: "bg-emerald-500",
  },
  anthropic: {
    label: "Anthropic",
    bg: "bg-primary/10 dark:bg-primary/15",
    text: "text-primary dark:text-primary",
    border: "border-primary/25 dark:border-primary/30",
    dot: "bg-primary",
  },
  gemini: {
    label: "Gemini",
    bg: "bg-indigo-500/10 dark:bg-indigo-500/15",
    text: "text-indigo-700 dark:text-indigo-400",
    border: "border-indigo-500/25 dark:border-indigo-500/30",
    dot: "bg-indigo-500",
  },
};

export function ProtocolBadge({
  protocol,
  className,
  dot = true,
}: ProtocolBadgeProps) {
  const norm = (protocol ?? "").toLowerCase();
  const cfg = PROTOCOL_CONFIG[norm];

  if (!cfg) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-border bg-secondary/60 px-2 py-0.5 text-[11px] font-medium text-secondary-foreground",
          className
        )}
      >
        {protocol}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors",
        cfg.bg,
        cfg.text,
        cfg.border,
        className
      )}
    >
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", cfg.dot)} />}
      <span>{cfg.label}</span>
    </span>
  );
}
