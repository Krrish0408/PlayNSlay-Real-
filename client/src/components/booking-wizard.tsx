import { useState, useMemo, useEffect } from "react";
import { useGameTypes } from "@/hooks/use-game-types";
import { useBookings } from "@/hooks/use-bookings";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { GameCard } from "./game-card";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format, addHours, addMinutes, setHours, setMinutes } from "date-fns";
import { cn } from "@/lib/utils";
import { CalendarIcon, ChevronRight, ChevronLeft, ChevronDown, Loader2, CheckCircle2, Clock, AlertCircle, Gamepad2, Monitor, Sparkles, MapPin, Copy, Check } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { GameType } from "@shared/schema";
import { calculateBookingPrice } from "@shared/pricing";
import { Input } from "@/components/ui/input";
import { useGames } from "@/hooks/use-games";
import { useLoungeConfig } from "@/hooks/use-lounge-config";
import {
  buildBookingInterval,
  formatLoungeDate,
  formatLoungeTime,
  getTimezoneAbbr,
  getStartOfDayInTimezone,
} from "@/lib/timezone";

const WIZARD_DURATION_PRESETS = [
  { label: "30 Min", minutes: 30 },
  { label: "45 Min", minutes: 45 },
  { label: "1 Hour", minutes: 60 },
  { label: "1.5 Hours", minutes: 90 },
  { label: "2 Hours", minutes: 120 },
  { label: "3 Hours", minutes: 180 },
];

export function BookingWizard() {
  const { gameTypes, isLoading: loadingGames, refetch: refetchGameTypes } = useGameTypes();
  const { games: catalogGames } = useGames();
  const { createBooking } = useBookings();
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const { data: loungeConfig } = useLoungeConfig();
  const loungeTimezone = loungeConfig?.timezone || "Asia/Kolkata";
  const loungeLocation = loungeConfig?.name || "Play N' Slay Gaming Lounge";

  const [step, setStep] = useState(1);
  const [selectedGame, setSelectedGame] = useState<GameType | null>(null);
  const [date, setDate] = useState<Date | undefined>(new Date());
  const [startTime, setStartTime] = useState<string>("18:00");
  const [endTime, setEndTime] = useState<string>("19:00");
  const [selectedDurationMins, setSelectedDurationMins] = useState<number>(60);
  const [isCustomDuration, setIsCustomDuration] = useState<boolean>(false);
  const [customDurationInput, setCustomDurationInput] = useState<string>("60");
  const [showManualEndTime, setShowManualEndTime] = useState<boolean>(false);
  const [players, setPlayers] = useState<string>("1");
  const [paymentMethod, setPaymentMethod] = useState<"online" | "offline">("offline");
  const [confirmedBooking, setConfirmedBooking] = useState<any | null>(null);
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [copiedRef, setCopiedRef] = useState(false);

  const handleCopyRef = (refText: string) => {
    try {
      navigator.clipboard.writeText(refText);
      setCopiedRef(true);
      setTimeout(() => setCopiedRef(false), 2000);
      toast({
        title: "Copied!",
        description: `Booking Reference ${refText} copied to clipboard.`,
      });
    } catch {}
  };

  const applyWizardDuration = (mins: number, baseStartTime?: string) => {
    setSelectedDurationMins(mins);
    const startStr = baseStartTime !== undefined ? baseStartTime : startTime;
    if (!startStr) return;
    const [h, m] = startStr.split(":").map(Number);
    const baseDate = date || new Date();
    const startDate = setMinutes(setHours(baseDate, h), m);
    const endDate = addMinutes(startDate, mins);
    setEndTime(format(endDate, "HH:mm"));
  };

  const handleStartTimeChange = (newStartTime: string) => {
    setStartTime(newStartTime);
    if (selectedDurationMins > 0) {
      applyWizardDuration(selectedDurationMins, newStartTime);
    }
  };

  // Handle URL query params for direct booking from games catalog
  useEffect(() => {
    if (!gameTypes || gameTypes.length === 0 || !catalogGames || catalogGames.length === 0) return;

    const searchParams = new URLSearchParams(window.location.search);
    const paramGameTitle = searchParams.get("gameTitle") || searchParams.get("game");
    const paramPlatform = searchParams.get("platform");

    if (paramGameTitle) {
      if (!user) {
        toast({
          title: "Login Required",
          description: `Please log in or register to book a station for ${paramGameTitle}.`,
        });
        const currentTarget = window.location.pathname + window.location.search + window.location.hash;
        setLocation(`/auth?redirect=${encodeURIComponent(currentTarget)}`);
        return;
      }

      const foundGame = catalogGames.find(
        (g) => g.title.toLowerCase() === paramGameTitle.toLowerCase()
      );

      let matchingStation = gameTypes[0];
      const targetPlat = (paramPlatform || foundGame?.platforms || "").toLowerCase();

      if (targetPlat.includes("racing")) {
        matchingStation = gameTypes.find((gt) => gt.name.toLowerCase().includes("racing")) || matchingStation;
      } else if (targetPlat.includes("vr")) {
        matchingStation = gameTypes.find((gt) => gt.name.toLowerCase().includes("vr")) || matchingStation;
      } else if (targetPlat.includes("ps5")) {
        matchingStation = gameTypes.find((gt) => gt.name.toLowerCase().includes("ps5")) || matchingStation;
      } else if (targetPlat.includes("ps4")) {
        matchingStation = gameTypes.find((gt) => gt.name.toLowerCase().includes("ps4")) || matchingStation;
      }

      if (matchingStation) {
        setSelectedGame(matchingStation);
        if (foundGame) {
          setPlayers(String(Math.min(foundGame.minPlayers || 1, foundGame.maxPlayers || 1)));
        }
        setStep(2);

        setTimeout(() => {
          const el = document.getElementById("booking-section");
          if (el) {
            el.scrollIntoView({ behavior: "smooth" });
          }
        }, 150);
      }
    }
  }, [gameTypes, catalogGames]);

  // Constrain max player count options based on selected station
  const activeMaxPlayers = selectedGame?.maxPlayers || 4;

  // Derived calculations: Timezone-aware booking interval using configured lounge timezone
  const bookingInterval = useMemo(() => {
    if (!date || !startTime || !endTime) return null;
    const dateStr = format(date, "yyyy-MM-dd");
    try {
      return buildBookingInterval(dateStr, startTime, endTime, loungeTimezone);
    } catch {
      return null;
    }
  }, [date, startTime, endTime, loungeTimezone]);

  const bookingDateTime = bookingInterval?.startTime ?? null;
  const endDateTime = bookingInterval?.endTime ?? null;
  const durationHours = bookingInterval?.durationHours ?? 0;

  const totalCost = useMemo(() => {
    if (!selectedGame || durationHours <= 0) return 0;

    return calculateBookingPrice(selectedGame, durationHours, parseInt(players)) / 100;
  }, [selectedGame, durationHours, players]);

  const handleBook = async () => {
    if (!user) {
      setLocation("/auth");
      return;
    }

    if (!selectedGame || !bookingDateTime || !endDateTime || durationHours <= 0) return;

    setBookingError(null);

    try {
      const created = await createBooking.mutateAsync({
        gameTypeId: selectedGame.id,
        startTime: bookingDateTime,
        endTime: endDateTime,
        playerCount: parseInt(players),
        paymentMethod,
        locationId: loungeConfig?.id || "main-lounge",
      });

      // Show confirmation ONLY after the backend confirms the booking was successfully created
      setConfirmedBooking(created);
      setStep(4);
    } catch (error: any) {
      // Booking creation failed: show appropriate error instead of false confirmation
      setBookingError(error?.message || "Failed to reserve station. Please choose a different time slot or station.");
    }
  };

  const handleResetWizard = () => {
    setConfirmedBooking(null);
    setBookingError(null);
    setSelectedGame(null);
    setDate(new Date());
    setStartTime("18:00");
    setEndTime("19:00");
    setSelectedDurationMins(60);
    setPlayers("1");
    setPaymentMethod("offline");
    setStep(1);
  };

  if (loadingGames) return (
    <div className="flex justify-center items-center py-20">
      <Loader2 className="w-12 h-12 text-primary animate-spin" />
    </div>
  );

  if (!gameTypes || gameTypes.length === 0) return (
    <div className="text-center py-20 space-y-4">
      <div className="w-12 h-12 rounded-full bg-destructive/10 text-destructive mx-auto flex items-center justify-center border border-destructive/20">
        <AlertCircle className="w-6 h-6" />
      </div>
      <h3 className="text-xl font-bold text-destructive">Unable to load gaming stations.</h3>
      <p className="text-muted-foreground max-w-md mx-auto text-sm">
        We could not load station availability. Please check your connection and try again.
      </p>
      <Button
        variant="outline"
        onClick={() => refetchGameTypes()}
        className="border-primary/30 hover:border-primary text-primary mt-2"
      >
        Retry Loading Stations
      </Button>
    </div>
  );

  return (
    <div className="w-full max-w-5xl mx-auto px-1 sm:px-4">
      {/* Progress Steps */}
      <div className="flex justify-center mb-6 sm:mb-8 relative px-1">
        <div className="flex items-center gap-1 sm:gap-3 text-xs sm:text-sm font-medium">
          {[1, 2, 3, 4].map((s) => (
            <div key={s} className="flex items-center gap-1 sm:gap-2">
              <div
                className={cn(
                  "w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center border transition-all duration-300 text-xs sm:text-sm shrink-0 font-bold",
                  step === s
                    ? s === 4
                      ? "bg-emerald-500 text-white border-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.5)]"
                      : "bg-primary text-primary-foreground border-primary shadow-[0_0_15px_theme(colors.primary.DEFAULT)]"
                    : step > s || (s === 4 && step === 4)
                    ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/50"
                    : "bg-card border-white/10 text-muted-foreground"
                )}
                aria-label={`Step ${s}: ${s === 1 ? "Station" : s === 2 ? "Schedule" : s === 3 ? "Review" : "Confirmed"}`}
              >
                {step > s || (s === 4 && step === 4) ? (
                  <CheckCircle2 className="w-4 h-4 sm:w-5 sm:h-5 text-emerald-400" />
                ) : (
                  s
                )}
              </div>
              <span
                className={cn(
                  "text-xs sm:text-sm whitespace-nowrap",
                  step === s ? "text-foreground font-bold inline" : "text-muted-foreground hidden sm:inline"
                )}
              >
                {s === 1 ? "Station" : s === 2 ? "Schedule" : s === 3 ? "Review" : "Confirmed"}
              </span>
              {s < 4 && <div className="w-2 sm:w-8 h-[1px] bg-white/10 mx-0.5 sm:mx-1" />}
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
            className="space-y-4 sm:space-y-6"
          >
            <div className="text-center mb-6 sm:mb-8 px-2">
              <h2 className="text-2xl sm:text-3xl font-display font-bold text-white mb-2">Choose Your Arsenal</h2>
              <p className="text-xs sm:text-sm text-muted-foreground">Select a gaming station type to begin your reservation.</p>
            </div>

            {!user && (
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-4 rounded-xl bg-primary/10 border border-primary/20 backdrop-blur-md text-xs sm:text-sm text-foreground">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center text-primary shrink-0">
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div className="text-left">
                    <p className="font-semibold text-white">Log in required to reserve a station</p>
                    <p className="text-muted-foreground text-xs">Members enjoy fast check-in, live timer tracking, and instant confirmations.</p>
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setLocation(`/auth?redirect=${encodeURIComponent("/#booking-section")}`)}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 font-bold text-xs h-9 shrink-0 cursor-pointer shadow-[0_0_15px_rgba(0,243,255,0.3)]"
                >
                  Sign In / Register
                </Button>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
              {gameTypes?.map((game) => (
                <GameCard
                  key={game.id}
                  game={game}
                  selected={selectedGame?.id === game.id}
                  onSelect={(g) => {
                    if (!user) {
                      toast({
                        title: "Login Required",
                        description: "Please sign in or create an account to book your gaming station.",
                      });
                      setLocation(`/auth?redirect=${encodeURIComponent("/#booking-section")}`);
                      return;
                    }
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
            className="max-w-2xl mx-auto bg-card/50 backdrop-blur-md border border-white/10 rounded-2xl p-4 sm:p-6 md:p-8"
          >
            <h2 className="text-xl sm:text-2xl font-display font-bold mb-4 sm:mb-6 text-center">Schedule Your Session</h2>

            <div className="grid gap-5 sm:gap-8">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5 sm:space-y-2">
                  <label className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                    <CalendarIcon className="w-4 h-4 text-primary" /> Select Date
                  </label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant={"outline"}
                        className={cn(
                          "w-full justify-start text-left font-normal h-11 sm:h-12 text-sm sm:text-base border-white/10 hover:border-primary/50",
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
                        disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0))}
                        className="bg-card text-foreground"
                      />
                    </PopoverContent>
                  </Popover>
                </div>

                <div className="space-y-1.5 sm:space-y-2">
                  <label className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                    <Clock className="w-4 h-4 text-primary" /> Start Time
                  </label>
                  <Input
                    type="time"
                    value={startTime}
                    onChange={(e) => handleStartTimeChange(e.target.value)}
                    onClick={(e) => {
                      try {
                        (e.currentTarget as HTMLInputElement).showPicker?.();
                      } catch {}
                    }}
                    className="h-11 sm:h-12 bg-background/60 border-white/10 focus:border-primary/50 text-sm sm:text-base font-mono cursor-pointer"
                  />
                </div>
              </div>

              {/* Session Timing & Duration Controls */}
              <div className="space-y-4 rounded-xl border border-white/10 bg-white/[0.02] p-3.5 sm:p-4">
                {/* Duration Presets */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-secondary" /> Select Duration:
                    </label>
                    <span className="text-xs font-bold text-primary bg-primary/10 px-2 py-0.5 rounded border border-primary/20">
                      {selectedDurationMins} Mins ({(selectedDurationMins / 60).toFixed(1)} hrs)
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                    {WIZARD_DURATION_PRESETS.map((preset) => {
                      const isSelected = !isCustomDuration && selectedDurationMins === preset.minutes;
                      return (
                        <Button
                          key={preset.minutes}
                          type="button"
                          variant={isSelected ? "default" : "outline"}
                          onClick={() => {
                            setIsCustomDuration(false);
                            applyWizardDuration(preset.minutes);
                          }}
                          className={`h-10 text-xs font-bold transition-all cursor-pointer ${
                            isSelected
                              ? "bg-primary text-primary-foreground shadow-[0_0_15px_rgba(0,243,255,0.35)] border-primary"
                              : "border-white/10 bg-card/40 hover:bg-white/10 text-foreground"
                          }`}
                        >
                          {preset.label}
                        </Button>
                      );
                    })}

                    {/* Custom Button */}
                    <Button
                      type="button"
                      variant={isCustomDuration ? "default" : "outline"}
                      onClick={() => {
                        setIsCustomDuration(true);
                        const val = parseInt(customDurationInput) || 60;
                        applyWizardDuration(val);
                      }}
                      className={`h-10 text-xs font-bold transition-all cursor-pointer ${
                        isCustomDuration
                          ? "bg-secondary text-secondary-foreground shadow-[0_0_15px_rgba(168,85,247,0.35)] border-secondary"
                          : "border-white/10 bg-card/40 hover:bg-white/10 text-muted-foreground"
                      }`}
                    >
                      Custom...
                    </Button>
                  </div>

                  {/* Custom Minutes Input */}
                  {isCustomDuration && (
                    <div className="flex items-center gap-2 pt-1 animate-in fade-in duration-200">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const next = Math.max(15, (parseInt(customDurationInput) || 60) - 15);
                          setCustomDurationInput(next.toString());
                          applyWizardDuration(next);
                        }}
                        className="h-9 px-3 text-xs font-bold border-white/10 cursor-pointer"
                      >
                        -15m
                      </Button>
                      <div className="relative flex-1">
                        <Input
                          type="number"
                          min="15"
                          max="720"
                          step="5"
                          value={customDurationInput}
                          onChange={(e) => {
                            setCustomDurationInput(e.target.value);
                            const v = parseInt(e.target.value);
                            if (v > 0) applyWizardDuration(v);
                          }}
                          className="h-9 text-center bg-background border-white/20 font-bold pr-12"
                          placeholder="Enter minutes"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-semibold pointer-events-none">
                          mins
                        </span>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const next = (parseInt(customDurationInput) || 60) + 15;
                          setCustomDurationInput(next.toString());
                          applyWizardDuration(next);
                        }}
                        className="h-9 px-3 text-xs font-bold border-white/10 cursor-pointer"
                      >
                        +15m
                      </Button>
                    </div>
                  )}
                </div>

                {/* Session Window Summary - Whole bar clickable to toggle options, and clicking the time directly edits it */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setShowManualEndTime(!showManualEndTime)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setShowManualEndTime(!showManualEndTime);
                    }
                  }}
                  className={`w-full flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-xs transition-all cursor-pointer select-none text-left ${
                    showManualEndTime
                      ? "bg-primary/10 border-primary/50 shadow-[0_0_20px_rgba(0,243,255,0.15)]"
                      : "bg-card/70 border-white/10 hover:border-primary/40 hover:bg-card/90"
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <div className={`p-1.5 rounded-md ${showManualEndTime ? "bg-primary text-black" : "bg-white/5 text-primary"}`}>
                      <Clock className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-[11px] text-muted-foreground font-medium">Session Time Window (Click time to edit)</div>
                      <div className="flex items-center gap-2 mt-1" onClick={(e) => e.stopPropagation()}>
                        <div className="relative inline-flex items-center">
                          <input
                            type="time"
                            value={startTime}
                            onChange={(e) => handleStartTimeChange(e.target.value)}
                            onClick={(e) => {
                              try {
                                (e.currentTarget as HTMLInputElement).showPicker?.();
                              } catch {}
                            }}
                            className="h-8 px-2 bg-background/90 hover:bg-background focus:bg-background border border-white/20 hover:border-primary/60 focus:border-primary rounded font-mono font-bold text-sm text-foreground cursor-pointer transition-all focus:outline-none focus:ring-1 focus:ring-primary shadow-sm"
                            title="Click to edit start time"
                          />
                        </div>
                        <span className="text-primary font-bold">➔</span>
                        <div className="relative inline-flex items-center">
                          <input
                            type="time"
                            value={endTime}
                            onChange={(e) => {
                              setEndTime(e.target.value);
                              if (startTime && e.target.value) {
                                const [sh, sm] = startTime.split(":").map(Number);
                                const [eh, em] = e.target.value.split(":").map(Number);
                                let diff = (eh * 60 + em) - (sh * 60 + sm);
                                if (diff < 0) diff += 24 * 60;
                                if (diff > 0) {
                                  setSelectedDurationMins(diff);
                                  setCustomDurationInput(diff.toString());
                                }
                              }
                            }}
                            onClick={(e) => {
                              try {
                                (e.currentTarget as HTMLInputElement).showPicker?.();
                              } catch {}
                            }}
                            className="h-8 px-2 bg-background/90 hover:bg-background focus:bg-background border border-white/20 hover:border-primary/60 focus:border-primary rounded font-mono font-bold text-sm text-foreground cursor-pointer transition-all focus:outline-none focus:ring-1 focus:ring-primary shadow-sm"
                            title="Click to edit end time"
                          />
                        </div>
                        <span className="text-[10px] font-semibold text-primary/90 bg-primary/10 px-1.5 py-0.5 rounded border border-primary/20">
                          {selectedDurationMins}m
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-primary ml-auto">
                    <span>{showManualEndTime ? "Hide options" : "More options"}</span>
                    <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${showManualEndTime ? "rotate-180" : ""}`} />
                  </div>
                </div>

                {showManualEndTime && (
                  <div className="p-3.5 rounded-lg bg-card/80 border border-primary/30 space-y-3 animate-in fade-in duration-200 shadow-inner">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Adjust Session Times</span>
                      <span className="text-[11px] text-primary">Duration updates automatically</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">Start Time</label>
                        <Input
                          type="time"
                          value={startTime}
                          onChange={(e) => handleStartTimeChange(e.target.value)}
                          onClick={(e) => {
                            try {
                              (e.currentTarget as HTMLInputElement).showPicker?.();
                            } catch {}
                          }}
                          className="h-10 bg-background border-white/15 focus:border-primary text-sm font-mono cursor-pointer"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">End Time</label>
                        <Input
                          type="time"
                          value={endTime}
                          onChange={(e) => {
                            setEndTime(e.target.value);
                            if (startTime && e.target.value) {
                              const [sh, sm] = startTime.split(":").map(Number);
                              const [eh, em] = e.target.value.split(":").map(Number);
                              let diff = (eh * 60 + em) - (sh * 60 + sm);
                              if (diff < 0) diff += 24 * 60;
                              if (diff > 0) {
                                setSelectedDurationMins(diff);
                                setCustomDurationInput(diff.toString());
                              }
                            }
                          }}
                          onClick={(e) => {
                            try {
                              (e.currentTarget as HTMLInputElement).showPicker?.();
                            } catch {}
                          }}
                          className="h-10 bg-background border-white/15 focus:border-primary text-sm font-mono cursor-pointer"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground flex items-center justify-between">
                  <span>Number of Players</span>
                  <span className="text-xs text-muted-foreground">Up to {activeMaxPlayers} Player{activeMaxPlayers > 1 ? 's' : ''}</span>
                </label>
                <Select value={players} onValueChange={setPlayers}>
                  <SelectTrigger className="h-12 bg-background border-white/10">
                    <SelectValue placeholder="Players" />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-white/10">
                    {Array.from({ length: activeMaxPlayers }, (_, i) => i + 1).map(n => (
                      <SelectItem key={n} value={n.toString()}>{n} Player{n > 1 ? 's' : ''}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Desktop inline action area */}
              <div className="hidden sm:flex justify-between items-center pt-4">
                <Button variant="outline" onClick={() => setStep(1)} className="border-white/10 hover:bg-white/5 h-11 px-4">
                  <ChevronLeft className="mr-2 h-4 w-4" /> Back
                </Button>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <span className="text-[10px] uppercase text-muted-foreground block font-semibold">Total Price</span>
                    <span className="font-display font-bold text-primary text-lg">₹{totalCost.toFixed(2)}</span>
                  </div>
                  <Button
                    onClick={() => {
                      if (!user) {
                        toast({
                          title: "Login Required",
                          description: "Please sign in or register to complete your reservation.",
                        });
                        setLocation(`/auth?redirect=${encodeURIComponent("/#booking-section")}`);
                        return;
                      }
                      setStep(3);
                    }}
                    disabled={!date || !startTime || !endTime || durationHours <= 0}
                    className="bg-primary text-primary-foreground hover:bg-primary/90 h-11 px-6 font-bold shadow-[0_0_15px_rgba(0,243,255,0.3)]"
                  >
                    Review Booking <ChevronRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Mobile Sticky Action Bar */}
              <div className="sm:hidden fixed bottom-0 left-0 right-0 z-40 bg-background/95 backdrop-blur-xl border-t border-white/15 px-4 py-3 pb-safe shadow-2xl flex items-center justify-between gap-3">
                <Button variant="outline" onClick={() => setStep(1)} className="h-11 px-3 border-white/10 text-xs font-semibold">
                  <ChevronLeft className="w-4 h-4 mr-1" /> Back
                </Button>
                <div className="text-center px-1">
                  <span className="text-[10px] uppercase text-muted-foreground block leading-tight font-medium">Estimated</span>
                  <span className="font-display font-bold text-primary text-base">₹{totalCost.toFixed(2)}</span>
                </div>
                <Button
                  onClick={() => {
                    if (!user) {
                      toast({
                        title: "Login Required",
                        description: "Please sign in or register to complete your reservation.",
                      });
                      setLocation(`/auth?redirect=${encodeURIComponent("/#booking-section")}`);
                      return;
                    }
                    setStep(3);
                  }}
                  disabled={!date || !startTime || !endTime || durationHours <= 0}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 h-11 px-4 font-bold text-xs shadow-[0_0_15px_rgba(0,243,255,0.4)]"
                >
                  Continue <ChevronRight className="ml-1 w-4 h-4" />
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
            className="max-w-md mx-auto px-1 sm:px-0"
          >
            <div className="bg-card/80 backdrop-blur-xl border border-primary/20 rounded-2xl overflow-hidden shadow-[0_0_50px_rgba(0,243,255,0.1)]">
              <div className="p-4 sm:p-6 bg-primary/10 border-b border-primary/10 text-center">
                <h2 className="text-xl sm:text-2xl font-display font-bold text-white">Booking Summary</h2>
              </div>

              <div className="p-4 sm:p-8 space-y-4 sm:space-y-6">
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Station Type</span>
                    <span className="font-bold text-lg">{selectedGame.name}</span>
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Location</span>
                    <span className="font-semibold text-sm flex items-center gap-1">
                      <MapPin className="w-3.5 h-3.5 text-primary" /> {loungeLocation}
                    </span>
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Date</span>
                    <span className="font-medium">
                      {bookingDateTime ? formatLoungeDate(bookingDateTime, loungeConfig?.id) : date ? format(date, "PPP") : "-"}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Time ({getTimezoneAbbr(bookingDateTime || new Date(), loungeTimezone)})</span>
                    <span className="font-medium font-mono text-sm">
                      {bookingDateTime && endDateTime
                        ? `${formatLoungeTime(bookingDateTime, loungeConfig?.id)} - ${formatLoungeTime(endDateTime, loungeConfig?.id)}`
                        : `${startTime} - ${endTime}`}
                      {bookingInterval?.crossesMidnight && (
                        <span className="ml-1.5 text-xs text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded border border-amber-400/20">
                          +1 day
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Players</span>
                    <span className="font-medium">{players}</span>
                  </div>
                  <div className="h-px bg-white/10 my-4" />
                  <div className="flex justify-between items-center text-xl">
                    <span className="text-muted-foreground font-medium">Total Price</span>
                    <span className="font-bold text-primary font-display tracking-wider text-2xl">₹{totalCost.toFixed(2)}</span>
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
                          paymentMethod === "offline" && "bg-primary text-primary-foreground shadow-[0_0_15px_rgba(0,243,255,0.3)]"
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
                          paymentMethod === "online" && "bg-primary text-primary-foreground shadow-[0_0_15px_rgba(0,243,255,0.3)]"
                        )}
                        onClick={() => setPaymentMethod("online")}
                      >
                        Pay Online
                      </Button>
                    </div>
                  </div>
                </div>

                {bookingError && (
                  <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/30 text-destructive flex items-start gap-3 animate-in fade-in">
                    <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                    <div className="text-sm">
                      <p className="font-semibold">Booking Creation Failed</p>
                      <p className="text-destructive/90 text-xs mt-0.5">{bookingError}</p>
                    </div>
                  </div>
                )}

                <div className="space-y-3 pt-4">
                  <Button
                    onClick={handleBook}
                    className="w-full h-12 text-base sm:text-lg font-bold bg-gradient-to-r from-primary to-secondary hover:opacity-90 shadow-lg touch-target"
                    disabled={createBooking.isPending}
                  >
                    {createBooking.isPending ? <Loader2 className="animate-spin mr-2" /> : null}
                    {user ? "CONFIRM BOOKING" : "LOGIN TO BOOK"}
                  </Button>
                  <Button variant="ghost" onClick={() => setStep(2)} className="w-full h-11 text-muted-foreground hover:text-foreground">
                    Back to Adjust
                  </Button>
                </div>

                {/* Mobile Sticky Action Bar for Step 3 */}
                <div className="sm:hidden fixed bottom-0 left-0 right-0 z-40 bg-background/95 backdrop-blur-xl border-t border-white/15 px-4 py-3 pb-safe shadow-2xl flex items-center justify-between gap-3">
                  <Button variant="outline" onClick={() => setStep(2)} className="h-11 px-3 border-white/10 text-xs font-semibold">
                    <ChevronLeft className="w-4 h-4 mr-1" /> Adjust
                  </Button>
                  <div className="text-center px-1">
                    <span className="text-[10px] uppercase text-muted-foreground block leading-tight font-medium">Payable</span>
                    <span className="font-display font-bold text-primary text-base">₹{totalCost.toFixed(2)}</span>
                  </div>
                  <Button
                    onClick={handleBook}
                    disabled={createBooking.isPending}
                    className="bg-gradient-to-r from-primary to-secondary text-primary-foreground font-bold h-11 px-4 text-xs shadow-lg"
                  >
                    {createBooking.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
                    Confirm Booking
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {step === 4 && confirmedBooking && (
          <motion.div
            key="step4"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            className="max-w-lg mx-auto px-1 sm:px-0"
          >
            <div className="bg-card/85 backdrop-blur-2xl border border-emerald-500/30 rounded-2xl overflow-hidden shadow-[0_0_60px_rgba(16,185,129,0.15)] relative">
              {/* Header Banner */}
              <div className="p-6 bg-gradient-to-b from-emerald-500/20 via-emerald-500/10 to-transparent border-b border-emerald-500/20 text-center relative overflow-hidden">
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-40 h-40 bg-emerald-500/10 rounded-full blur-2xl pointer-events-none" />
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 mb-3 shadow-[0_0_20px_rgba(16,185,129,0.3)]">
                  <CheckCircle2 className="w-9 h-9" />
                </div>
                <h2 className="text-2xl sm:text-3xl font-display font-extrabold text-white tracking-wide">
                  Booking Confirmed!
                </h2>
                <p className="text-sm text-emerald-300/90 mt-1 font-medium flex items-center justify-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-emerald-400" />
                  Your gaming station has been successfully reserved.
                </p>
              </div>

              {/* Confirmation Details Card */}
              <div className="p-4 sm:p-7 space-y-4 sm:space-y-5">
                {/* Booking ID and Reference Badge */}
                <div className="flex items-center justify-between p-3.5 rounded-xl bg-white/5 border border-white/10">
                  <div>
                    <span className="text-xs uppercase tracking-wider text-muted-foreground font-semibold block">Booking ID</span>
                    <span className="text-xl font-bold font-mono text-primary">#{confirmedBooking.id}</span>
                  </div>
                  {confirmedBooking.bookingRef && (
                    <div className="text-right flex flex-col items-end">
                      <span className="text-xs uppercase tracking-wider text-muted-foreground font-semibold block">Reference</span>
                      <button
                        type="button"
                        onClick={() => handleCopyRef(confirmedBooking.bookingRef)}
                        className="inline-flex items-center gap-1.5 text-xs font-mono font-bold bg-white/10 hover:bg-white/20 active:bg-white/30 px-2.5 py-1.5 rounded-md text-foreground border border-white/10 mt-0.5 transition-colors cursor-pointer"
                        title="Click to copy booking reference"
                        aria-label="Copy booking reference"
                      >
                        <span>{confirmedBooking.bookingRef}</span>
                        {copiedRef ? (
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="w-3.5 h-3.5 text-muted-foreground" />
                        )}
                      </button>
                    </div>
                  )}
                </div>

                {/* 6 Required Core Fields Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  {/* Game Type */}
                  <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/10 flex items-start gap-3">
                    <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0 mt-0.5">
                      <Gamepad2 className="w-5 h-5" />
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground uppercase font-semibold block tracking-wider">Game Type</span>
                      <span className="font-semibold text-white text-sm">
                        {confirmedBooking.gameType?.name || selectedGame?.name || "Gaming Lounge"}
                      </span>
                    </div>
                  </div>

                  {/* Assigned Station */}
                  <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/10 flex items-start gap-3">
                    <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0 mt-0.5">
                      <Monitor className="w-5 h-5" />
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground uppercase font-semibold block tracking-wider">Assigned Station</span>
                      <span className="font-semibold text-emerald-300 text-sm">
                        {confirmedBooking.station?.name || (confirmedBooking.stationId ? `Station #${confirmedBooking.stationId}` : "Auto-Assigned Station")}
                      </span>
                    </div>
                  </div>

                  {/* Date */}
                  <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/10 flex items-start gap-3 sm:col-span-2">
                    <div className="w-9 h-9 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 shrink-0 mt-0.5">
                      <CalendarIcon className="w-5 h-5" />
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground uppercase font-semibold block tracking-wider">Date</span>
                      <span className="font-semibold text-white text-sm">
                        {confirmedBooking.startTime
                          ? formatLoungeDate(confirmedBooking.startTime, confirmedBooking.locationId || loungeConfig?.id)
                          : date
                          ? format(date, "EEEE, MMMM d, yyyy")
                          : "-"}
                      </span>
                    </div>
                  </div>

                  {/* Start Time */}
                  <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/10 flex items-start gap-3">
                    <div className="w-9 h-9 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 shrink-0 mt-0.5">
                      <Clock className="w-5 h-5" />
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground uppercase font-semibold block tracking-wider">
                        Start Time ({getTimezoneAbbr(confirmedBooking.startTime || new Date(), loungeTimezone)})
                      </span>
                      <span className="font-semibold text-white font-mono text-sm">
                        {confirmedBooking.startTime
                          ? formatLoungeTime(confirmedBooking.startTime, confirmedBooking.locationId || loungeConfig?.id)
                          : startTime}
                      </span>
                    </div>
                  </div>

                  {/* End Time */}
                  <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/10 flex items-start gap-3">
                    <div className="w-9 h-9 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 shrink-0 mt-0.5">
                      <Clock className="w-5 h-5" />
                    </div>
                    <div>
                      <span className="text-xs text-muted-foreground uppercase font-semibold block tracking-wider">
                        End Time ({getTimezoneAbbr(confirmedBooking.endTime || new Date(), loungeTimezone)})
                      </span>
                      <span className="font-semibold text-white font-mono text-sm">
                        {confirmedBooking.endTime
                          ? formatLoungeTime(confirmedBooking.endTime, confirmedBooking.locationId || loungeConfig?.id)
                          : endTime}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Additional Summary Info */}
                <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/10 space-y-2 text-xs">
                  <div className="flex justify-between items-center text-muted-foreground">
                    <span>Players</span>
                    <span className="font-medium text-foreground">{confirmedBooking.playerCount ?? players} Player{(confirmedBooking.playerCount ?? Number(players)) > 1 ? "s" : ""}</span>
                  </div>
                  <div className="flex justify-between items-center text-muted-foreground">
                    <span>Payment Method</span>
                    <span className="font-medium text-foreground capitalize">
                      {confirmedBooking.paymentMethod === "offline" ? "Pay at Lounge (Counter)" : "Online Payment"}
                    </span>
                  </div>
                  <div className="h-px bg-white/5 my-1.5" />
                  <div className="flex justify-between items-center text-sm">
                    <span className="font-medium text-muted-foreground">Total Amount</span>
                    <span className="font-bold text-primary font-display text-lg">
                      ₹{confirmedBooking.totalPrice !== undefined ? (Number(confirmedBooking.totalPrice) / 100).toFixed(2) : totalCost.toFixed(2)}
                    </span>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="space-y-3 pt-2">
                  <Button
                    onClick={() => setLocation("/dashboard")}
                    className="w-full h-11 text-base font-bold bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_20px_rgba(0,243,255,0.25)]"
                  >
                    View in My Dashboard
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleResetWizard}
                    className="w-full h-11 border-white/10 hover:bg-white/5 text-muted-foreground hover:text-white"
                  >
                    Book Another Session
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
