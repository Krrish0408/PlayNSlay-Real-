"use client";

import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, History as HistoryIcon } from "lucide-react";
import { format } from "date-fns";
import type { Booking } from "@/shared/schema";

export default function EmployeeRecentPage() {
  const { user } = useAuth();
  const { data: bookings, isLoading } = useQuery<Booking[]>({
    queryKey: ["/api/bookings"],
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
      </div>
    );
  }

  const employeeBookings = bookings?.filter((b: any) => b.employeeId === user?.id) || [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-display font-bold flex items-center gap-2">
          <HistoryIcon className="w-8 h-8 text-primary" />
          SESSION HISTORY LOG
        </h1>
        <p className="text-muted-foreground uppercase text-[10px] tracking-widest mt-1">
          Complete ledger of sessions initiated by your account
        </p>
      </div>

      <Card className="bg-card/40 backdrop-blur-sm border-white/10 overflow-hidden">
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-white/5">
              <TableRow className="border-white/5">
                <TableHead className="font-display text-xs">REF CODE</TableHead>
                <TableHead className="font-display text-xs">CUSTOMER</TableHead>
                <TableHead className="font-display text-xs">STATION</TableHead>
                <TableHead className="font-display text-xs">DATE</TableHead>
                <TableHead className="font-display text-xs">TIME</TableHead>
                <TableHead className="font-display text-xs">PAYMENT</TableHead>
                <TableHead className="text-right font-display text-xs">AMOUNT</TableHead>
                <TableHead className="text-right font-display text-xs">STATUS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {employeeBookings.map((booking: any) => (
                <TableRow key={booking.id} className="border-white/5 hover:bg-white/5 transition-colors">
                  <TableCell className="font-mono text-xs text-muted-foreground">{booking.bookingRef}</TableCell>
                  <TableCell className="font-semibold">{booking.user?.username || "Walk-in Guest"}</TableCell>
                  <TableCell>{booking.gameType?.name || "Gaming Station"}</TableCell>
                  <TableCell>{format(new Date(booking.startTime), "PP")}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-sm">
                    {format(new Date(booking.startTime), "HH:mm")} - {format(new Date(booking.endTime), "HH:mm")}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {booking.paymentMethod}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono font-bold text-primary">
                    ₹{booking.totalPrice}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge
                      variant="outline"
                      className={
                        booking.status === "Approved"
                          ? "text-green-400 border-green-500/50"
                          : booking.status === "Pending"
                          ? "text-yellow-400 border-yellow-500/50"
                          : "text-blue-400 border-blue-500/50"
                      }
                    >
                      {booking.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
              {employeeBookings.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-12 text-muted-foreground italic">
                    No sessions recorded yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
