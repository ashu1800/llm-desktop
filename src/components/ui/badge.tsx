import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none select-none",
  {
    variants: {
      variant: {
        default:
          "border-primary/30 bg-primary text-primary-foreground shadow-2xs",
        secondary:
          "border-border/80 bg-secondary/80 text-secondary-foreground shadow-2xs",
        destructive:
          "border-destructive/30 bg-destructive/10 text-destructive shadow-2xs",
        outline: "border-border/80 text-foreground bg-background/50",
        success:
          "border-success/30 bg-success/10 text-success shadow-2xs",
        warning:
          "border-warning/35 bg-warning/10 text-warning shadow-2xs",
        muted:
          "border-border/60 bg-muted/60 text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
