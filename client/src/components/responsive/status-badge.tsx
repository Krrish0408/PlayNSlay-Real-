import React from "react";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  Clock,
  XCircle,
  AlertCircle,
  PlayCircle,
  Wrench,
  Check,
  UserCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface StatusBadgeProps {
  status: string;
  className?: string;
  size?: "sm" | "default";
}

export function StatusBadge({ status, className, size = "default" }: StatusBadgeProps) {
  const norm = (status || "").toLowerCase().trim();

  let icon = <Clock className="w-3.5 h-3.5" />;
  let label = status;
  let colorClass = "bg-yellow-500/15 text-yellow-400 border-yellow-500/30";

  if (norm === "approved" || norm === "confirmed") {
    icon = <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
    label = norm === "approved" ? "Approved" : "Confirmed";
    colorClass = "bg-emerald-500/15 text-emerald-300 border-emerald-500/30 shadow-[0_0_10px_rgba(16,185,129,0.15)]";
  } else if (norm === "completed") {
    icon = <Check className="w-3.5 h-3.5 text-cyan-400 shrink-0" />;
    label = "Completed";
    colorClass = "bg-cyan-500/15 text-cyan-300 border-cyan-500/30";
  } else if (norm === "in progress" || norm === "in-progress" || norm === "active") {
    icon = <PlayCircle className="w-3.5 h-3.5 text-primary shrink-0 animate-pulse" />;
    label = "In Session";
    colorClass = "bg-primary/15 text-primary border-primary/30 shadow-[0_0_10px_rgba(0,243,255,0.2)]";
  } else if (norm === "checked in" || norm === "checked-in") {
    icon = <UserCheck className="w-3.5 h-3.5 text-indigo-400 shrink-0" />;
    label = "Checked In";
    colorClass = "bg-indigo-500/15 text-indigo-300 border-indigo-500/30";
  } else if (norm === "pending") {
    icon = <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
    label = "Pending";
    colorClass = "bg-amber-500/15 text-amber-300 border-amber-500/30";
  } else if (norm === "cancelled") {
    icon = <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />;
    label = "Cancelled";
    colorClass = "bg-rose-500/15 text-rose-300 border-rose-500/30";
  } else if (norm === "rejected") {
    icon = <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />;
    label = "Rejected";
    colorClass = "bg-red-500/15 text-red-300 border-red-500/30";
  } else if (norm === "available") {
    icon = <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
    label = "Available";
    colorClass = "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  } else if (norm === "occupied" || norm === "in use") {
    icon = <PlayCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
    label = "Occupied";
    colorClass = "bg-amber-500/15 text-amber-400 border-amber-500/30";
  } else if (norm === "maintenance") {
    icon = <Wrench className="w-3.5 h-3.5 text-red-400 shrink-0" />;
    label = "Maintenance";
    colorClass = "bg-red-500/15 text-red-400 border-red-500/30";
  }

  return (
    <Badge
      variant="outline"
      className={cn(
        "inline-flex items-center gap-1.5 font-medium border font-mono tracking-tight",
        size === "sm" ? "text-[10px] px-2 py-0.5" : "text-xs px-2.5 py-1",
        colorClass,
        className
      )}
    >
      {icon}
      <span>{label}</span>
    </Badge>
  );
}
