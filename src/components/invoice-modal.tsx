"use client";

import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Booking, GameType } from "@/shared/schema";
import { format } from "date-fns";
import { Printer } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { calculateBookingPrice } from "@/shared/pricing";

interface InvoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  booking: Booking & { user?: { username: string } };
}

export function InvoiceModal({ isOpen, onClose, booking }: InvoiceModalProps) {
  const { data: gameTypes } = useQuery<GameType[]>({ queryKey: ["/api/game-types"] });

  const gameType = gameTypes?.find((g) => g.id === booking.gameTypeId);

  const handlePrint = () => {
    window.print();
  };

  if (!booking) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl bg-white text-black p-0 overflow-hidden sm:rounded-lg" id="invoice-content">
        <div className="p-8 print:p-0">
          {/* Invoice Header */}
          <div className="flex justify-between items-start border-b border-gray-200 pb-6 mb-6">
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-gray-900">INVOICE</h1>
              <p className="text-sm text-gray-500 mt-1">#{booking.bookingRef}</p>
            </div>
            <div className="text-right">
              <h2 className="text-lg font-semibold text-gray-900">Play N&apos; Slay Gaming Lounge</h2>
              <p className="text-sm text-gray-500">123 Gaming Street</p>
              <p className="text-sm text-gray-500">Cyber City</p>
            </div>
          </div>

          {/* Bill To & Details */}
          <div className="grid grid-cols-2 gap-8 mb-8">
            <div>
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-2">Bill To</h3>
              <p className="font-medium text-gray-900">{booking.user?.username || "Guest Customer"}</p>
              <p className="text-sm text-gray-500">{format(new Date(), "PP")}</p>
            </div>
            <div className="text-right">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-2">Booking Details</h3>
              <p className="text-sm"><span className="font-medium">Date:</span> {format(new Date(booking.startTime), "PP")}</p>
              <p className="text-sm"><span className="font-medium">Time:</span> {format(new Date(booking.startTime), "p")} - {format(new Date(booking.endTime), "p")}</p>
            </div>
          </div>

          {/* Items Table */}
          <table className="w-full mb-8">
            <thead>
              <tr className="border-b border-gray-200 text-left text-sm">
                <th className="py-2 font-semibold text-gray-500">Description</th>
                <th className="py-2 font-semibold text-gray-500 text-right">Rate</th>
                <th className="py-2 font-semibold text-gray-500 text-right">Duration</th>
                <th className="py-2 font-semibold text-gray-500 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="text-gray-700">
              <tr className="border-b border-gray-100">
                <td className="py-4">
                  <p className="font-medium text-gray-900">{gameType?.name || "Gaming Session"}</p>
                  <p className="text-sm text-gray-400">Station Rental ({booking.playerCount} Players)</p>
                </td>
                <td className="py-4 text-right">₹{gameType?.hourlyPrice || 0}/hr</td>
                <td className="py-4 text-right">
                  {((new Date(booking.endTime).getTime() - new Date(booking.startTime).getTime()) / (1000 * 60 * 60)).toFixed(1)} hrs
                </td>
                <td className="py-4 text-right font-medium">
                  ₹{gameType ? calculateBookingPrice(gameType, (new Date(booking.endTime).getTime() - new Date(booking.startTime).getTime()) / (1000 * 60 * 60), booking.playerCount) : booking.totalPrice}
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} className="pt-4 text-right font-bold text-gray-900">Total Amount</td>
                <td className="pt-4 text-right font-bold text-lg text-primary">₹{booking.totalPrice}</td>
              </tr>
            </tfoot>
          </table>

          {/* Footer */}
          <div className="border-t border-gray-200 pt-6 text-center text-sm text-gray-500">
            <p>Thank you for playing at Play N&apos; Slay! Game On.</p>
          </div>
        </div>

        {/* Print Actions */}
        <div className="bg-gray-50 px-8 py-4 flex justify-end gap-3 print:hidden">
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={handlePrint} className="gap-2">
            <Printer className="w-4 h-4" /> Print Invoice
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
