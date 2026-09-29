import React from "react";
import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-white/5 border border-white/5", className)}
      {...props}
    />
  );
}

export function StationCardSkeleton() {
  return (
    <div className="rounded-2xl border border-white/10 bg-card/40 p-4 space-y-4">
      <Skeleton className="h-44 w-full rounded-xl" />
      <div className="space-y-2">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <div className="flex justify-between items-center pt-2">
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-9 w-24 rounded-lg" />
      </div>
    </div>
  );
}

export function MetricCardSkeleton() {
  return (
    <div className="rounded-xl border border-white/10 bg-card/40 p-4 sm:p-5 space-y-3">
      <div className="flex justify-between items-center">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-5 w-5 rounded-full" />
      </div>
      <Skeleton className="h-8 w-24" />
      <Skeleton className="h-3 w-36" />
    </div>
  );
}

export function BookingRowSkeleton() {
  return (
    <div className="p-4 rounded-xl border border-white/10 bg-card/30 space-y-3">
      <div className="flex justify-between items-center">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <Skeleton className="h-4 w-48" />
      <div className="flex justify-between items-center pt-1">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-20 rounded-lg" />
      </div>
    </div>
  );
}

export function LoadingSkeleton({
  type = "booking",
  count = 1,
}: {
  type?: "metrics" | "station" | "booking";
  count?: number;
}) {
  const items = Array.from({ length: count });

  if (type === "metrics") {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {items.map((_, i) => (
          <MetricCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (type === "station") {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {items.map((_, i) => (
          <StationCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((_, i) => (
        <BookingRowSkeleton key={i} />
      ))}
    </div>
  );
}
