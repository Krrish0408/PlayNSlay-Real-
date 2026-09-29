import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  actionHref?: string;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  actionHref,
  className,
}: EmptyStateProps) {
  return (
    <Card className={cn("bg-card/40 border-white/10 border-dashed text-center", className)}>
      <CardContent className="flex flex-col items-center justify-center py-10 sm:py-14 px-4 sm:px-6">
        <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary mb-4 shadow-[0_0_20px_rgba(0,243,255,0.15)]">
          <Icon className="w-7 h-7 sm:w-8 sm:h-8" />
        </div>
        <h3 className="text-lg sm:text-xl font-display font-bold text-foreground mb-2">
          {title}
        </h3>
        <p className="text-xs sm:text-sm text-muted-foreground max-w-sm mb-6 leading-relaxed">
          {description}
        </p>

        {actionLabel && (
          actionHref ? (
            <a href={actionHref}>
              <Button className="bg-primary text-primary-foreground font-semibold hover:bg-primary/90 shadow-[0_0_15px_rgba(0,243,255,0.3)] touch-target px-6">
                {actionLabel}
              </Button>
            </a>
          ) : (
            <Button
              onClick={onAction}
              className="bg-primary text-primary-foreground font-semibold hover:bg-primary/90 shadow-[0_0_15px_rgba(0,243,255,0.3)] touch-target px-6"
            >
              {actionLabel}
            </Button>
          )
        )}
      </CardContent>
    </Card>
  );
}
