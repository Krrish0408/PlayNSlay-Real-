"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertBookingSchema } from "@/shared/schema";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Save, Clock, Check } from "lucide-react";
import { format, addHours, setHours, setMinutes } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { z } from "zod";
import { useState, useEffect } from "react";
import { InvoiceModal } from "@/components/invoice-modal";
import { calculateBookingPrice } from "@/shared/pricing";

export default function BookingEntryPage() {
  const { toast } = useToast();
  const { data: gameTypes } = useQuery({ queryKey: ["/api/game-types"] });
  const { data: bookings } = useQuery({ queryKey: ["/api/bookings"] });

  const [showInvoice, setShowInvoice] = useState(false);
  const [currentBooking, setCurrentBooking] = useState<any>(null);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const form = useForm({
    resolver: zodResolver(
      insertBookingSchema
        .extend({
          gameTypeId: z.string().min(1, "Station is required"),
          username: z.string().min(1, "Customer name is required"),
          startTimeStr: z.string().min(1, "Start time is required"),
          endTimeStr: z.string().min(1, "End time is required"),
          playerCount: z.coerce.number().min(1).default(1),
        })
        .omit({ startTime: true, endTime: true })
    ),
    defaultValues: {
      username: "",
      gameTypeId: "",
      playerCount: 1,
      startTimeStr: format(new Date(), "HH:mm"),
      endTimeStr: format(addHours(new Date(), 1), "HH:mm"),
      paymentMethod: "offline",
    },
  });

  const mutation = useMutation({
    mutationFn: async (data: any) => {
      const today = new Date();
      const [startH, startM] = data.startTimeStr.split(":").map(Number);
      const [endH, endM] = data.endTimeStr.split(":").map(Number);

      const startTime = setMinutes(setHours(today, startH), startM);
      let endTime = setMinutes(setHours(today, endH), endM);

      if (endTime < startTime) {
        endTime = new Date(endTime.getTime() + 24 * 60 * 60 * 1000);
      }

      const res = await apiRequest("POST", "/api/bookings/offline", {
        ...data,
        startTime,
        endTime,
      });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employee/stats"] });
      toast({ title: "Booking Created", description: "The customer entry has been recorded." });

      setCurrentBooking(data);
      setShowInvoice(true);

      form.reset({
        username: "",
        gameTypeId: "",
        playerCount: 1,
        startTimeStr: format(new Date(), "HH:mm"),
        endTimeStr: format(addHours(new Date(), 1), "HH:mm"),
        paymentMethod: "offline",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Booking Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const completeBookingMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/bookings/${id}/timer`, { action: "stop" });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employee/stats"] });
      toast({ title: "Session Completed" });
    },
  });

  // Calculate live preview price
  const watchedGameTypeId = form.watch("gameTypeId");
  const watchedStartTime = form.watch("startTimeStr");
  const watchedEndTime = form.watch("endTimeStr");
  const watchedPlayerCount = form.watch("playerCount");

  const selectedGameObj = (gameTypes as any[])?.find((g) => g.id.toString() === watchedGameTypeId);

  let calculatedGameCost = 0;
  if (selectedGameObj && watchedStartTime && watchedEndTime) {
    const [sH, sM] = watchedStartTime.split(":").map(Number);
    const [eH, eM] = watchedEndTime.split(":").map(Number);
    let diffHours = eH + eM / 60 - (sH + sM / 60);
    if (diffHours < 0) diffHours += 24;
    if (diffHours > 0) {
      calculatedGameCost = calculateBookingPrice(selectedGameObj, diffHours, Number(watchedPlayerCount) || 1);
    }
  }

  const grandTotal = calculatedGameCost;
  const activeSessions = (bookings as any[])?.filter((b) => b.status === "Approved") || [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-display font-bold">DIRECT BOOKING &amp; POS ENTRY</h1>
        <p className="text-muted-foreground uppercase text-[10px] tracking-widest mt-1">
          Counter walk-ins billing
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left 2 Cols: Booking Form */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="bg-card/40 backdrop-blur-sm border-white/10">
            <CardHeader>
              <CardTitle className="font-display">Customer &amp; Station Details</CardTitle>
              <CardDescription>Enter player details and duration</CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...form}>
                <form onSubmit={form.handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="username"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Customer Name / Phone</FormLabel>
                          <FormControl>
                            <Input placeholder="e.g. Rahul Sharma" {...field} className="bg-background/50 border-white/10" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="gameTypeId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Gaming Station</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger className="bg-background/50 border-white/10">
                                <SelectValue placeholder="Select station type" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent className="bg-card border-white/10">
                              {(gameTypes as any[])?.map((game) => (
                                <SelectItem key={game.id} value={game.id.toString()}>
                                  {game.name} (₹{game.hourlyPrice}/hr)
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <FormField
                      control={form.control}
                      name="startTimeStr"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Start Time</FormLabel>
                          <FormControl>
                            <Input type="time" {...field} className="bg-background/50 border-white/10" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="endTimeStr"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>End Time</FormLabel>
                          <FormControl>
                            <Input type="time" {...field} className="bg-background/50 border-white/10" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="playerCount"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Player Count</FormLabel>
                          <Select onValueChange={(val) => field.onChange(parseInt(val, 10))} value={field.value?.toString() || "1"}>
                            <FormControl>
                              <SelectTrigger className="bg-background/50 border-white/10">
                                <SelectValue placeholder="Players" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent className="bg-card border-white/10">
                              {[1, 2, 3, 4].map((n) => (
                                <SelectItem key={n} value={n.toString()}>
                                  {n} Player{n > 1 ? "s" : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="pt-4 flex justify-between items-center border-t border-white/10">
                    <div>
                      <span className="text-xs text-muted-foreground uppercase tracking-widest">Total Amount</span>
                      <div className="text-3xl font-display font-bold text-primary">₹{grandTotal}</div>
                    </div>
                    <Button
                      type="submit"
                      size="lg"
                      className="bg-primary text-primary-foreground font-display font-bold px-8 shadow-[0_0_20px_rgba(0,243,255,0.4)]"
                      disabled={mutation.isPending}
                    >
                      {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                      <Save className="w-4 h-4 mr-2" /> RECORD &amp; BILL
                    </Button>
                  </div>
                </form>
              </Form>
            </CardContent>
          </Card>
        </div>

        {/* Right Col: Active Live Sessions */}
        <div className="space-y-6">
          <Card className="bg-card/40 backdrop-blur-sm border-white/10">
            <CardHeader>
              <CardTitle className="text-lg font-display flex items-center gap-2">
                <Clock className="w-5 h-5 text-primary" /> Active Stations
              </CardTitle>
              <CardDescription>Live sessions currently running</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {activeSessions.map((booking: any) => {
                const end = new Date(booking.endTime);
                const diff = end.getTime() - now.getTime();
                const mins = Math.max(0, Math.floor(diff / 60000));
                const secs = Math.max(0, Math.floor((diff % 60000) / 1000));

                return (
                  <div
                    key={booking.id}
                    className="p-4 rounded-lg bg-background/50 border border-white/5 space-y-3"
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <h4 className="font-bold text-sm">{booking.user?.username || "Walk-in Guest"}</h4>
                        <p className="text-xs text-muted-foreground">{booking.gameType?.name || "Station"}</p>
                      </div>
                      <Badge className={diff <= 0 ? "bg-red-500 animate-pulse" : "bg-primary/20 text-primary border-primary/40"}>
                        {diff <= 0 ? "TIME UP" : `${mins}:${secs.toString().padStart(2, "0")}`}
                      </Badge>
                    </div>

                    <div className="flex justify-between items-center pt-2 border-t border-white/5">
                      <span className="text-xs font-mono font-bold text-primary">₹{booking.totalPrice}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => completeBookingMutation.mutate(booking.id)}
                        className="text-xs border-green-500/40 text-green-400 hover:bg-green-500/10 gap-1 h-7"
                      >
                        <Check className="w-3 h-3" /> Complete Session
                      </Button>
                    </div>
                  </div>
                );
              })}

              {activeSessions.length === 0 && (
                <p className="text-sm text-muted-foreground italic text-center py-6">
                  No stations currently running.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {currentBooking && (
        <InvoiceModal
          isOpen={showInvoice}
          onClose={() => setShowInvoice(false)}
          booking={currentBooking}
        />
      )}
    </div>
  );
}
