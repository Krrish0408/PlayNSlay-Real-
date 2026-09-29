import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Booking, GameType, Station } from "@shared/schema";
import { format } from "date-fns";
import { Printer } from "lucide-react";
import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { calculateBookingPrice } from "@shared/pricing";

interface InvoiceModalProps {
    isOpen: boolean;
    onClose: () => void;
    booking: Booking & { user?: { username: string }; station?: Station | null };
}

export function InvoiceModal({ isOpen, onClose, booking }: InvoiceModalProps) {
    const { data: gameTypes } = useQuery<GameType[]>({ queryKey: ["/api/game-types"] });

    const gameType = gameTypes?.find(g => g.id === booking?.gameTypeId);

    const handlePrint = () => {
        window.print();
    };

    if (!booking) return null;

    const isStationBooking = Boolean(booking?.gameTypeId);
    const durationHours = Math.max(0.25, (new Date(booking.endTime).getTime() - new Date(booking.startTime).getTime()) / (1000 * 60 * 60));
    const effectiveFinalPrice = booking.finalPrice ?? booking.totalPrice ?? 0;
    const baseCost = booking.basePrice ?? (isStationBooking && gameType ? calculateBookingPrice(gameType, durationHours, booking.playerCount) : effectiveFinalPrice);
    const discountAmount = booking.discountAmount ?? Math.max(0, baseCost - effectiveFinalPrice);

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-3xl bg-white text-black p-0 overflow-hidden sm:rounded-lg" id="invoice-content">
                <div className="p-8 print:p-0">
                    {/* Invoice Header */}
                    <div className="flex justify-between items-start border-b border-gray-200 pb-6 mb-6">
                        <div>
                            <h1 className="text-3xl font-bold tracking-tight text-gray-900">INVOICE RECEIPT</h1>
                            <p className="text-sm font-mono text-gray-500 mt-1">Ref: #{booking.bookingRef}</p>
                        </div>
                        <div className="text-right">
                            <h2 className="text-lg font-bold text-gray-900">PLAY N' SLAY GAMING LOUNGE</h2>
                            <p className="text-xs text-gray-500">2nd Floor, Shivarth Plaza, Ranjhi</p>
                            <p className="text-xs text-gray-500">Jabalpur, MP • +91 8817978822</p>
                        </div>
                    </div>

                    {/* Bill To & Details */}
                    <div className="grid grid-cols-2 gap-8 mb-8">
                        <div>
                            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Customer Details</h3>
                            <p className="font-semibold text-gray-800">{booking.user?.username || "Guest Customer"}</p>
                            <p className="text-xs text-gray-500">Payment: <span className="capitalize font-medium">{booking.paymentMethod}</span></p>
                        </div>
                        <div className="text-right">
                            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
                                {isStationBooking ? "Session Timing" : "Purchase Date"}
                            </h3>
                            <p className="text-sm"><span className="font-medium text-gray-600">Date:</span> {format(new Date(booking.startTime), "PP")}</p>
                            {isStationBooking && (
                                <p className="text-sm"><span className="font-medium text-gray-600">Time:</span> {format(new Date(booking.startTime), "p")} - {format(new Date(booking.endTime), "p")}</p>
                            )}
                        </div>
                    </div>

                    {/* Items Table */}
                    <table className="w-full mb-8">
                        <thead>
                            <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wider">
                                <th className="py-2.5 font-semibold text-gray-500">Description</th>
                                <th className="py-2.5 font-semibold text-gray-500 text-right">Unit Rate</th>
                                <th className="py-2.5 font-semibold text-gray-500 text-right">Qty / Duration</th>
                                <th className="py-2.5 font-semibold text-gray-500 text-right">Total</th>
                            </tr>
                        </thead>
                        <tbody className="text-gray-700 text-sm divide-y divide-gray-100">
                            {/* Station Session Line (Only if game station booked) */}
                            {isStationBooking && (
                                <tr>
                                    <td className="py-3.5">
                                        <p className="font-semibold text-gray-900">
                                            {gameType?.name || "Gaming Session"} {booking.station?.name ? `• ${booking.station.name}` : ""}
                                        </p>
                                        <p className="text-xs text-gray-500">Station Rental ({booking.playerCount} Player{booking.playerCount > 1 ? "s" : ""})</p>
                                        {booking.pricingRule && (
                                            <p className="text-[10px] text-gray-400 font-mono">Rule: {booking.pricingRule}</p>
                                        )}
                                    </td>
                                    <td className="py-3.5 text-right font-mono">₹{((gameType?.hourlyPrice || 0) / 100).toFixed(2)}/hr</td>
                                    <td className="py-3.5 text-right font-mono">
                                        {durationHours.toFixed(1)} hrs
                                    </td>
                                    <td className="py-3.5 text-right font-semibold font-mono text-gray-900">
                                        ₹{(baseCost / 100).toFixed(2)}
                                    </td>
                                </tr>
                            )}
                            {discountAmount > 0 && (
                                <tr>
                                    <td colSpan={3} className="py-2 text-right text-xs text-emerald-600 font-medium">
                                        Discount Applied:
                                    </td>
                                    <td className="py-2 text-right font-mono text-emerald-600 font-medium text-xs">
                                        -₹{(discountAmount / 100).toFixed(2)}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                        <tfoot>
                            <tr className="border-t-2 border-gray-900">
                                <td colSpan={3} className="pt-4 text-right font-bold text-gray-900 text-base">Grand Total</td>
                                <td className="pt-4 text-right font-bold text-xl text-primary font-mono">₹{(effectiveFinalPrice / 100).toFixed(2)}</td>
                            </tr>
                        </tfoot>
                    </table>

                    {/* Footer */}
                    <div className="border-t border-gray-200 pt-6 text-center text-xs text-gray-500">
                        <p className="font-medium text-gray-700">Thank you for gaming with Play N' Slay!</p>
                        <p className="mt-1">Follow us for tournament schedules and member rewards.</p>
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
