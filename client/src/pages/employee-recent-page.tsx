import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, History as HistoryIcon, Printer } from "lucide-react";
import { format } from "date-fns";
import type { Booking, GameType } from "@shared/schema";
import { useState } from "react";
import { InvoiceModal } from "@/components/invoice-modal";

export default function EmployeeRecentPage() {
  const { user } = useAuth();
  const { data: bookings, isLoading } = useQuery<Booking[]>({
    queryKey: ["/api/bookings"],
  });
  const { data: gameTypes } = useQuery<GameType[]>({
    queryKey: ["/api/game-types"],
  });

  const [selectedBooking, setSelectedBooking] = useState<any>(null);
  const [showInvoice, setShowInvoice] = useState(false);

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="w-10 h-10 text-primary animate-spin" />
      </div>
    );
  }

  const employeeBookings = bookings?.filter((b: any) => b.employeeId === user?.id || (user?.role === "admin" && b.bookingRef?.startsWith("OFF-"))) || [];

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
                <TableHead className="text-right font-display text-xs">RECEIPT</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {employeeBookings.map((booking: any) => {
                const gameType = gameTypes?.find(g => g.id === booking.gameTypeId);
                return (
                  <TableRow key={booking.id} className="border-white/5 hover:bg-white/5 transition-colors">
                    <TableCell className="font-mono text-xs text-muted-foreground">{booking.bookingRef}</TableCell>
                    <TableCell className="font-semibold">{booking.user?.username || "Walk-in Guest"}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span>{booking.gameType?.name || gameType?.name || "Gaming Station"}</span>
                        {booking.station?.name && (
                          <Badge variant="outline" className="text-[10px] font-mono border-primary/30 text-primary bg-primary/5">
                            {booking.station.name}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
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
                      ₹{(booking.totalPrice / 100).toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant="outline"
                        className={
                          booking.status === "Approved" || booking.status === "Completed"
                            ? "text-green-400 border-green-500/50 bg-green-500/10"
                            : booking.status === "Pending"
                            ? "text-yellow-400 border-yellow-500/50 bg-yellow-500/10"
                            : "text-red-400 border-red-500/50 bg-red-500/10"
                        }
                      >
                        {booking.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setSelectedBooking({
                            ...booking,
                            user: booking.user || { username: "Guest" },
                            gameType: booking.gameType || gameType,
                          });
                          setShowInvoice(true);
                        }}
                      >
                        <Printer className="w-4 h-4 text-muted-foreground hover:text-foreground" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {employeeBookings.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-12 text-muted-foreground italic">
                    No sessions recorded yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {selectedBooking && (
        <InvoiceModal
          isOpen={showInvoice}
          onClose={() => setShowInvoice(false)}
          booking={selectedBooking}
        />
      )}
    </div>
  );
}
