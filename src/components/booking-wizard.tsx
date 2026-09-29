"use client";

import { useState, useMemo } from "react";
import { useGameTypes } from "@/hooks/use-game-types";
import { useBookings } from "@/hooks/use-bookings";
import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "next/navigation";
import { GameCard } from "./game-card";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format, setHours, setMinutes } from "date-fns";
import { cn } from "@/lib/utils";
import { CalendarIcon, ChevronRight, ChevronLeft, Loader2, CheckCircle2, Clock } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { GameType } from "@/shared/schema";
import { calculateBookingPrice } from "@/shared/pricing";
import { Input } from "@/components/ui/input";

export function BookingWizard() {
  const { gameTypes, isLoading: loadingGames } = useGameTypes();
  const { createBooking } = useBookings();
  const { user } = useAuth();
  const router = useRouter();

  const [step, setStep] = useState(1);
  const [selectedGame, setSelectedGame] = useState<GameType | null>(null);
  const [date, setDate] = useState<Date | undefined>(new Date());
  const [startTime, setStartTime] = useState<string>("18:00");
  const [endTime, setEndTime] = useState<string>("20:00");
  const [players, setPlayers] = useState<string>("1");
  const [paymentMethod, setPaymentMethod] = useState<"online" | "offline">("offline");

  // Derived calculations
  const bookingDateTime = useMemo(() => {
    if (!date || !startTime) return null;
    const [hours, minutes] = startTime.split(":").map(Number);
    return setHours(setMinutes(date, minutes), hours);
  }, [date, startTime]);

  const endDateTime = useMemo(() => {
    if (!date || !endTime) return null;
    const [hours, minutes] = endTime.split(":").map(Number);
    return setHours(setMinutes(date, minutes), hours);
  }, [date, endTime]);

  const durationHours = useMemo(() => {
    if (!bookingDateTime || !endDateTime) return 0;
    const diff = endDateTime.getTime() - bookingDateTime.getTime();
    return Math.max(0, diff / (1000 * 60 * 60));
  }, [bookingDateTime, endDateTime]);

  const totalCost = useMemo(() => {
    if (!selectedGame || durationHours <= 0) return 0;
    return calculateBookingPrice(selectedGame, durationHours, parseInt(players));
  }, [selectedGame, durationHours, players]);

  const handleBook = async () => {
    if (!user) {
      router.push("/auth");
      return;
    }

    if (!selectedGame || !bookingDateTime || !endDateTime || durationHours <= 0) return;

    try {
      await createBooking.mutateAsync({
        gameTypeId: selectedGame.id,
        startTime: bookingDateTime,
        endTime: endDateTime,
        playerCount: parseInt(players),
        paymentMethod,
      });
      router.push("/dashboard");
    } catch (error) {
      // Handled by hook
    }
  };

  if (loadingGames) {
    return (
      <div className="flex justify-center items-center py-20">
        <Loader2 className="w-12 h-12 text-primary animate-spin" />
      </div>
    );
  }

  if (!gameTypes || gameTypes.length === 0) {
    return (
      <div className="text-center py-20">
        <h3 className="text-xl font-bold text-destructive">Unable to load gaming stations.</h3>
        <p className="text-muted-foreground mt-2">Please check your connection and try refreshing.</p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-5xl mx-auto">
      {/* Progress Steps */}
      <div className="flex justify-center mb-8 relative">
        <div className="flex items-center gap-4 text-sm font-medium">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center border transition-all duration-300",
                  step === s
                    ? "bg-primary text-primary-foreground border-primary shadow-[0_0_15px_theme(colors.primary.DEFAULT)]"
                    : step > s
                    ? "bg-primary/20 text-primary border-primary"
                    : "bg-card border-white/10 text-muted-foreground"
                )}
              >
                {step > s ? <CheckCircle2 className="w-5 h-5" /> : s}
              </div>
              <span className={cn(step >= s ? "text-foreground" : "text-muted-foreground")}>
                {s === 1 ? "Select Station" : s === 2 ? "Date & Time" : "Confirm"}
              </span>
              {s < 3 && <div className="w-12 h-[1px] bg-white/10 mx-2" />}
            </div>
          ))}
        </div>
      </div>

      <AnimatePresence mode="wait">
        {step === 1 && (
          <motion.div
            key="step1"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="space-y-6"
          >
            <div className="text-center mb-8">
              <h2 className="text-3xl font-display font-bold text-white mb-2">Choose Your Arsenal</h2>
              <p className="text-muted-foreground">Select a gaming station type to begin your reservation.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {gameTypes?.map((game: any) => (
                <GameCard
                  key={game.id}
                  game={game}
                  selected={selectedGame?.id === game.id}
                  onSelect={(g) => {
                    setSelectedGame(g);
                    setStep(2);
                  }}
                />
              ))}
            </div>
          </motion.div>
        )}

        {step === 2 && (
          <motion.div
            key="step2"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="max-w-2xl mx-auto bg-card/50 backdrop-blur-md border border-white/10 rounded-2xl p-8"
          >
            <h2 className="text-2xl font-display font-bold mb-6 text-center">Schedule Your Session</h2>

            <div className="grid gap-8">
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Select Date</label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant={"outline"}
                      className={cn(
                        "w-full justify-start text-left font-normal h-12 text-lg border-white/10 hover:border-primary/50",
                        !date && "text-muted-foreground"
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {date ? format(date, "PPP") : <span>Pick a date</span>}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0 bg-card border-white/10" align="start">
                    <Calendar
                      mode="single"
                      selected={date}
                      onSelect={setDate}
                      initialFocus
                      disabled={(d) => d < new Date(new Date().setHours(0, 0, 0, 0))}
                      className="bg-card text-foreground"
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Clock className="w-4 h-4" /> Start Time
                  </label>
                  <Input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="h-12 bg-background border-white/10 focus:border-primary/50 text-lg"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Clock className="w-4 h-4" /> End Time
                  </label>
                  <Input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="h-12 bg-background border-white/10 focus:border-primary/50 text-lg"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Number of Players</label>
                <Select value={players} onValueChange={setPlayers}>
                  <SelectTrigger className="h-12 bg-background border-white/10">
                    <SelectValue placeholder="Players" />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-white/10">
                    {Array.from({ length: selectedGame?.maxPlayers || 4 }, (_, i) => i + 1).map((n) => (
                      <SelectItem key={n} value={n.toString()}>
                        {n} Player{n > 1 ? "s" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex justify-between pt-4">
                <Button
                  variant="outline"
                  onClick={() => setStep(1)}
                  className="border-white/10 hover:bg-white/5"
                >
                  <ChevronLeft className="mr-2 h-4 w-4" /> Back
                </Button>
                <Button
                  onClick={() => setStep(3)}
                  disabled={!date || !startTime || !endTime || durationHours <= 0}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  Review Booking <ChevronRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </div>
          </motion.div>
        )}

        {step === 3 && selectedGame && (
          <motion.div
            key="step3"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="max-w-md mx-auto"
          >
            <div className="bg-card/80 backdrop-blur-xl border border-primary/20 rounded-2xl overflow-hidden shadow-[0_0_50px_rgba(0,243,255,0.1)]">
              <div className="p-6 bg-primary/10 border-b border-primary/10 text-center">
                <h2 className="text-2xl font-display font-bold text-white">Booking Summary</h2>
              </div>

              <div className="p-8 space-y-6">
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Station Type</span>
                    <span className="font-bold text-lg">{selectedGame.name}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Date</span>
                    <span className="font-medium">{date ? format(date, "PPP") : "-"}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Time</span>
                    <span className="font-medium">
                      {startTime} - {endDateTime && format(endDateTime, "HH:mm")}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Players</span>
                    <span className="font-medium">{players}</span>
                  </div>
                  <div className="h-px bg-white/10 my-4" />
                  <div className="flex justify-between items-center text-xl">
                    <span className="text-muted-foreground font-medium">Total Price</span>
                    <span className="font-bold text-primary font-display tracking-wider text-2xl">
                      ₹{totalCost}
                    </span>
                  </div>

                  <div className="h-px bg-white/10 my-4" />

                  <div className="space-y-3">
                    <label className="text-sm font-medium text-muted-foreground">Payment Method</label>
                    <div className="grid grid-cols-2 gap-3">
                      <Button
                        type="button"
                        variant={paymentMethod === "offline" ? "default" : "outline"}
                        className={cn(
                          "w-full border-white/10",
                          paymentMethod === "offline" &&
                            "bg-primary text-primary-foreground shadow-[0_0_15px_rgba(0,243,255,0.3)]"
                        )}
                        onClick={() => setPaymentMethod("offline")}
                      >
                        Pay at Lounge
                      </Button>
                      <Button
                        type="button"
                        variant={paymentMethod === "online" ? "default" : "outline"}
                        className={cn(
                          "w-full border-white/10",
                          paymentMethod === "online" &&
                            "bg-primary text-primary-foreground shadow-[0_0_15px_rgba(0,243,255,0.3)]"
                        )}
                        onClick={() => setPaymentMethod("online")}
                      >
                        Pay Online
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 pt-4">
                  <Button
                    onClick={handleBook}
                    className="w-full h-12 text-lg font-bold bg-gradient-to-r from-primary to-secondary hover:opacity-90 shadow-lg"
                    disabled={createBooking.isPending}
                  >
                    {createBooking.isPending ? <Loader2 className="animate-spin mr-2" /> : null}
                    {user ? "CONFIRM BOOKING" : "LOGIN TO BOOK"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setStep(2)}
                    className="w-full text-muted-foreground"
                  >
                    Back to Adjust
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
