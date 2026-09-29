import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertBookingSchema, GameType } from "@shared/schema";
import { useAuth } from "@/hooks/use-auth";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Save, History as HistoryIcon, Clock, IndianRupee, Calculator, Printer } from "lucide-react";
import { format, addHours, addMinutes, setHours, setMinutes } from "date-fns";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { z } from "zod";
import { useState, useMemo } from "react";
import { InvoiceModal } from "@/components/invoice-modal";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { calculateBookingPrice } from "@shared/pricing";
import { useStations } from "@/hooks/use-stations";

export default function BookingEntryPage() {
  const { toast } = useToast();
  const { data: gameTypes } = useQuery<GameType[]>({ queryKey: ["/api/game-types"] });
  const { data: bookings, isLoading: bookingsLoading } = useQuery({ queryKey: ["/api/bookings"] });
  const { stations } = useStations();

  const [showInvoice, setShowInvoice] = useState(false);
  const [currentBooking, setCurrentBooking] = useState<any>(null);

  // Duration State
  const DURATION_PRESETS = [
    { label: "30 Min", minutes: 30 },
    { label: "45 Min", minutes: 45 },
    { label: "60 Min (1h)", minutes: 60 },
    { label: "90 Min (1.5h)", minutes: 90 },
    { label: "120 Min (2h)", minutes: 120 },
    { label: "180 Min (3h)", minutes: 180 },
  ];
  const [selectedDurationMins, setSelectedDurationMins] = useState<number>(60);
  const [isCustomDuration, setIsCustomDuration] = useState<boolean>(false);
  const [customDurationInput, setCustomDurationInput] = useState<string>("60");
  const [showManualEndTime, setShowManualEndTime] = useState<boolean>(false);

  const form = useForm({
    resolver: zodResolver(insertBookingSchema.extend({
      gameTypeId: z.string().optional(),
      stationId: z.string().optional(),
      username: z.string().min(1, "Customer name is required"),
      startTimeStr: z.string().optional(),
      endTimeStr: z.string().optional(),
    }).omit({ startTime: true, endTime: true, playerCount: true })),
    defaultValues: {
      username: "",
      gameTypeId: "",
      stationId: "auto",
      playerCount: 1,
      startTimeStr: format(new Date(), "HH:mm"),
      endTimeStr: format(addMinutes(new Date(), 60), "HH:mm"),
      paymentMethod: "offline",
    },
  });

  const applyDuration = (mins: number, baseStartTime?: string) => {
    setSelectedDurationMins(mins);
    const startStr = baseStartTime !== undefined ? baseStartTime : (form.getValues("startTimeStr") || format(new Date(), "HH:mm"));
    if (!startStr) return;
    const [h, m] = startStr.split(":").map(Number);
    const startDate = setMinutes(setHours(new Date(), h), m);
    const endDate = addMinutes(startDate, mins);
    form.setValue("endTimeStr", format(endDate, "HH:mm"));
  };

  const handleStartTimeChange = (newStartTime: string) => {
    form.setValue("startTimeStr", newStartTime);
    if (selectedDurationMins > 0) {
      applyDuration(selectedDurationMins, newStartTime);
    }
  };

  const handleSetToNow = () => {
    const nowStr = format(new Date(), "HH:mm");
    form.setValue("startTimeStr", nowStr);
    applyDuration(selectedDurationMins, nowStr);
  };

  const watchedStartTime = form.watch("startTimeStr");
  const watchedEndTime = form.watch("endTimeStr");
  const watchedGameTypeId = form.watch("gameTypeId");
  const watchedPlayerCount = form.watch("playerCount");

  const isStationSelected = Boolean(watchedGameTypeId && watchedGameTypeId !== "");
  const selectedStation = useMemo(() => {
    if (!isStationSelected) return null;
    return gameTypes?.find(t => t.id.toString() === watchedGameTypeId);
  }, [gameTypes, watchedGameTypeId, isStationSelected]);

  const availableStationsForType = useMemo(() => {
    if (!watchedGameTypeId) return [];
    return stations?.filter(s => s.gameTypeId.toString() === watchedGameTypeId) || [];
  }, [stations, watchedGameTypeId]);

  const calculatedDuration = useMemo(() => {
    if (!isStationSelected || !watchedStartTime || !watchedEndTime) return 0;
    const [startH, startM] = watchedStartTime.split(":").map(Number);
    const [endH, endM] = watchedEndTime.split(":").map(Number);
    let startMinutes = startH * 60 + startM;
    let endMinutes = endH * 60 + endM;
    if (endMinutes < startMinutes) endMinutes += 24 * 60;
    return Math.max(0, (endMinutes - startMinutes) / 60);
  }, [isStationSelected, watchedStartTime, watchedEndTime]);

  const stationCost = useMemo(() => {
    if (!selectedStation || calculatedDuration <= 0) return 0;
    return calculateBookingPrice(selectedStation, calculatedDuration, watchedPlayerCount || 1);
  }, [selectedStation, calculatedDuration, watchedPlayerCount]);


  const totalCalculatedPrice = stationCost;

  const mutation = useMutation({
    mutationFn: async (data: any) => {
      const today = new Date();
      let startTime = today;
      let endTime = addMinutes(today, 60);

      if (data.startTimeStr && data.endTimeStr) {
        const [startH, startM] = data.startTimeStr.split(":").map(Number);
        const [endH, endM] = data.endTimeStr.split(":").map(Number);

        startTime = setMinutes(setHours(today, startH), startM);
        endTime = setMinutes(setHours(today, endH), endM);

        if (endTime < startTime) {
          endTime = new Date(endTime.getTime() + 24 * 60 * 60 * 1000);
        }
      }

      const res = await apiRequest("POST", "/api/bookings/offline", {
        ...data,
        gameTypeId: data.gameTypeId,
        startTime,
        endTime,
      });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bookings"] });
      toast({
        title: "Booking Created",
        description: "The customer entry has been recorded."
      });

      // Open Invoice Modal with populated user and gameType
      setCurrentBooking({
        ...data,
        user: { username: form.getValues("username") },
        gameType: selectedStation,
      });
      setShowInvoice(true);

      form.reset({
        username: "",
        gameTypeId: "",
        playerCount: 1,
        startTimeStr: format(new Date(), "HH:mm"),
        endTimeStr: format(addMinutes(new Date(), 60), "HH:mm"),
        paymentMethod: "offline",
      });
      setSelectedDurationMins(60);
      setIsCustomDuration(false);
      setCustomDurationInput("60");
      setShowManualEndTime(false);
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive"
      });
    },
  });

  const onSubmitBooking = (data: any) => {
    if (!data.gameTypeId) {
      toast({
        title: "Station Required",
        description: "Please select a gaming station.",
        variant: "destructive"
      });
      return;
    }
    mutation.mutate(data);
  };


  return (
    <div className="container mx-auto p-3 sm:p-6 space-y-6 sm:space-y-8 max-w-5xl pb-16">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 sm:gap-8">
        <div className="space-y-6 sm:space-y-8">
          <Card className="bg-card/50 border-white/10 h-fit">
            <CardHeader className="p-4 sm:p-6">
              <CardTitle className="font-display text-xl sm:text-2xl tracking-tight flex items-center gap-2">
                <Save className="w-5 h-5 text-primary" />
                NEW BOOKING ENTRY
              </CardTitle>
              <CardDescription className="text-xs sm:text-sm">Record manual entries for offline customers.</CardDescription>
            </CardHeader>
            <CardContent className="p-4 sm:p-6 pt-0">
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmitBooking)} className="space-y-5 sm:space-y-6">
                  <FormField
                    control={form.control}
                    name="username"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs sm:text-sm">Customer Name</FormLabel>
                        <FormControl>
                          <Input placeholder="Enter customer name" className="h-11 sm:h-12 bg-background/60 border-white/10 text-sm sm:text-base" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <FormField
                      control={form.control}
                      name="gameTypeId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Gaming Category</FormLabel>
                          <Select
                            onValueChange={(val) => {
                              field.onChange(val);
                              form.setValue("stationId", "auto");
                            }}
                            value={field.value || "none"}
                          >
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="Select category" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {gameTypes?.map((type) => (
                                <SelectItem key={type.id} value={type.id.toString()}>
                                  {type.name} (₹{(type.hourlyPrice / 100).toFixed(2)}/hr)
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="stationId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="flex justify-between">
                            <span>Physical Station</span>
                            <span className="text-[10px] text-muted-foreground">Auto or Pick</span>
                          </FormLabel>
                          <Select
                            onValueChange={field.onChange}
                            value={field.value || "auto"}
                            disabled={!isStationSelected}
                          >
                            <FormControl>
                              <SelectTrigger className={!isStationSelected ? "opacity-60 bg-white/5" : ""}>
                                <SelectValue placeholder="Auto-assign" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="auto">
                                ⚡ Auto-Assign Best Available
                              </SelectItem>
                              {availableStationsForType.map((st) => (
                                <SelectItem key={st.id} value={st.id.toString()} disabled={st.status !== "AVAILABLE"}>
                                  {st.name} {st.status !== "AVAILABLE" ? `(${st.status})` : "• Available"}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="playerCount"
                      render={({ field }) => {
                        const maxP = selectedStation?.maxPlayers || 4;
                        return (
                          <FormItem>
                            <FormLabel className="flex justify-between">
                              <span>Number of Players</span>
                              {selectedStation ? (
                                <span className="text-xs text-primary font-normal">
                                  {selectedStation.priceModel === "per_player" ? "Per-player rate" : "Flat rate"} (Max {maxP}P)
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground font-normal">
                                  Select station
                                </span>
                              )}
                            </FormLabel>
                            <Select
                              value={field.value?.toString() || "1"}
                              onValueChange={(v) => field.onChange(parseInt(v))}
                              disabled={!isStationSelected}
                            >
                              <FormControl>
                                <SelectTrigger className={!isStationSelected ? "opacity-60 bg-white/5" : ""}>
                                  <SelectValue placeholder="Select players" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {Array.from({ length: maxP }, (_, i) => i + 1).map(n => (
                                  <SelectItem key={n} value={n.toString()}>{n} Player{n > 1 ? 's' : ''}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        );
                      }}
                    />
                  </div>

                  {/* Session Timing & Duration Controls (Only if Station Selected) */}
                  {isStationSelected && (
                    <div className="space-y-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
                      {/* Start Time + Now button */}
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <FormField
                          control={form.control}
                          name="startTimeStr"
                          render={({ field }) => (
                            <FormItem className="flex-1">
                              <div className="flex items-center justify-between mb-1.5">
                                <FormLabel className="flex items-center gap-2 text-sm font-semibold">
                                  <Clock className="w-4 h-4 text-primary" /> Start Time
                                </FormLabel>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={handleSetToNow}
                                  className="h-6 px-2.5 text-xs font-semibold text-primary hover:text-primary hover:bg-primary/10 border border-primary/30 rounded-md cursor-pointer"
                                >
                                  ⚡ Set to Now
                                </Button>
                              </div>
                              <FormControl>
                                <Input
                                  type="time"
                                  value={field.value}
                                  onChange={(e) => handleStartTimeChange(e.target.value)}
                                  className="bg-background/60 border-white/10 font-mono text-base h-11"
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>

                      {/* Quick Duration Preset Selector */}
                      <div className="space-y-2.5 pt-1">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                            <Clock className="w-3.5 h-3.5 text-secondary" /> Select Duration:
                          </Label>
                          <span className="text-xs font-bold text-primary bg-primary/10 px-2 py-0.5 rounded border border-primary/20">
                            {selectedDurationMins} Mins ({(selectedDurationMins / 60).toFixed(1)} hrs)
                          </span>
                        </div>

                        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                          {DURATION_PRESETS.map((preset) => {
                            const isSelected = !isCustomDuration && selectedDurationMins === preset.minutes;
                            return (
                              <Button
                                key={preset.minutes}
                                type="button"
                                variant={isSelected ? "default" : "outline"}
                                onClick={() => {
                                  setIsCustomDuration(false);
                                  applyDuration(preset.minutes);
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

                          {/* Custom Duration Button */}
                          <Button
                            type="button"
                            variant={isCustomDuration ? "default" : "outline"}
                            onClick={() => {
                              setIsCustomDuration(true);
                              const val = parseInt(customDurationInput) || 60;
                              applyDuration(val);
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

                        {/* Custom Minutes Input & Stepper */}
                        {isCustomDuration && (
                          <div className="flex items-center gap-2 pt-1.5 animate-in fade-in duration-200">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                const next = Math.max(15, (parseInt(customDurationInput) || 60) - 15);
                                setCustomDurationInput(next.toString());
                                applyDuration(next);
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
                                  if (v > 0) applyDuration(v);
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
                                applyDuration(next);
                              }}
                              className="h-9 px-3 text-xs font-bold border-white/10 cursor-pointer"
                            >
                              +15m
                            </Button>
                          </div>
                        )}
                      </div>

                      {/* Computed Session Window Banner */}
                      <div className="flex items-center justify-between rounded-lg bg-card/60 border border-white/10 px-3.5 py-2.5 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">Session Window:</span>
                          <span className="font-mono font-bold text-foreground">
                            {watchedStartTime || "--:--"}
                          </span>
                          <span className="text-primary font-bold">➔</span>
                          <span className="font-mono font-bold text-foreground">
                            {watchedEndTime || "--:--"}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowManualEndTime(!showManualEndTime)}
                          className="text-[11px] text-muted-foreground hover:text-primary underline cursor-pointer"
                        >
                          {showManualEndTime ? "Hide End Time" : "Edit End Time"}
                        </button>
                      </div>

                      {/* Optional Manual End Time field */}
                      {showManualEndTime && (
                        <FormField
                          control={form.control}
                          name="endTimeStr"
                          render={({ field }) => (
                            <FormItem className="pt-2 animate-in fade-in duration-200">
                              <FormLabel className="text-xs text-muted-foreground">Manual End Time Override</FormLabel>
                              <FormControl>
                                <Input
                                  type="time"
                                  {...field}
                                  onChange={(e) => {
                                    field.onChange(e.target.value);
                                    if (watchedStartTime && e.target.value) {
                                      const [sh, sm] = watchedStartTime.split(":").map(Number);
                                      const [eh, em] = e.target.value.split(":").map(Number);
                                      let diff = (eh * 60 + em) - (sh * 60 + sm);
                                      if (diff < 0) diff += 24 * 60;
                                      if (diff > 0) {
                                        setSelectedDurationMins(diff);
                                        setCustomDurationInput(diff.toString());
                                      }
                                    }
                                  }}
                                  className="bg-background/60 border-white/10 font-mono text-sm"
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      )}
                    </div>
                  )}


                    {/* Live Calculated Price Breakdown */}
                    <div className="rounded-xl p-4 bg-primary/10 border border-primary/20 space-y-2.5">
                      <div className="flex items-center justify-between text-xs font-semibold uppercase text-primary tracking-wider">
                        <span className="flex items-center gap-1.5">
                          <Calculator className="w-3.5 h-3.5" /> Live Price Calculation
                        </span>
                        <span>{isStationSelected ? `${calculatedDuration.toFixed(1)} hrs session` : "Select a station"}</span>
                      </div>

                      <div className="space-y-1.5 text-sm">
                        {isStationSelected && (
                          <div className="flex justify-between items-center text-muted-foreground">
                            <span>
                              {selectedStation ? selectedStation.name : "Station Rental"}
                              {selectedStation ? ` (${selectedStation.priceModel === "per_player" ? `₹${(selectedStation.hourlyPrice / 100).toFixed(2)} × ${watchedPlayerCount || 1}p/hr` : `₹${(selectedStation.hourlyPrice / 100).toFixed(2)}/hr`})` : ""}
                            </span>
                            <span className="font-mono font-medium text-foreground">
                              ₹{(stationCost / 100).toFixed(2)}
                            </span>
                          </div>
                        )}


                        {!isStationSelected && (
                          <div className="text-xs text-muted-foreground italic py-1">
                            Please select a gaming station above.
                          </div>
                        )}
                      </div>

                      <div className="pt-2 border-t border-primary/20 flex justify-between items-center font-bold">
                        <span className="text-sm text-foreground">Final Total Payable</span>
                        <span className="text-2xl font-mono text-primary font-black">
                          ₹{(totalCalculatedPrice / 100).toFixed(2)}
                        </span>
                      </div>
                    </div>

                    <Button type="submit" className="w-full h-12 text-base font-bold bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_20px_rgba(0,243,255,0.3)] cursor-pointer" disabled={mutation.isPending}>
                      {mutation.isPending ? (
                        <Loader2 className="w-5 h-5 animate-spin mr-2" />
                      ) : (
                        <Save className="w-5 h-5 mr-2" />
                      )}
                      {`Confirm Entry & Collect ₹${(totalCalculatedPrice / 100).toFixed(2)}`}
                    </Button>
                </form>
              </Form>
            </CardContent>
          </Card>
        </div>

        <Card className="bg-card/50 border-white/10 overflow-hidden">
          <CardHeader className="p-4 sm:p-6 pb-3">
            <CardTitle className="font-display text-xl sm:text-2xl tracking-tight flex items-center gap-2">
              <HistoryIcon className="w-5 h-5 text-secondary" />
              RECENT ENTRIES
            </CardTitle>
            <CardDescription className="text-xs sm:text-sm">Recently recorded offline and manual bookings.</CardDescription>
          </CardHeader>
          <CardContent className="p-0 sm:p-6 sm:pt-0">
            {bookingsLoading ? (
              <div className="flex justify-center p-8"><Loader2 className="animate-spin text-primary" /></div>
            ) : (
              <>
                {/* Mobile Card List (< md:) */}
                <div className="md:hidden divide-y divide-white/5">
                  {Array.isArray(bookings) && bookings.slice(0, 10).map((booking: any) => (
                    <div key={booking.id} className="p-3.5 space-y-2 hover:bg-white/[0.02] transition-colors">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-sm text-foreground">{booking.user?.username || 'Guest'}</span>
                        <span className="font-mono font-bold text-primary text-sm">
                          ₹{(booking.totalPrice / 100).toFixed(2)}
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span>{booking.gameType?.name || (
                            <span className="text-[10px] text-muted-foreground bg-white/5 px-1.5 py-0.5 rounded border border-white/10">
                              No Category
                            </span>
                          )}</span>
                          {booking.station?.name && (
                            <Badge variant="outline" className="text-[9px] font-mono border-primary/30 text-primary bg-primary/5">
                              {booking.station.name}
                            </Badge>
                          )}
                        </div>
                        <span className="font-mono text-xs">
                          {booking.gameTypeId
                            ? `${format(new Date(booking.startTime), "HH:mm")} - ${format(new Date(booking.endTime), "HH:mm")}`
                            : format(new Date(booking.startTime), "HH:mm")}
                        </span>
                      </div>

                      <div className="flex items-center justify-end pt-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setCurrentBooking(booking);
                            setShowInvoice(true);
                          }}
                          className="h-8 px-2.5 text-xs border-white/10 hover:border-primary/50 gap-1 touch-target"
                        >
                          <Printer className="w-3.5 h-3.5 text-primary" />
                          <span>Invoice</span>
                        </Button>
                      </div>
                    </div>
                  ))}
                  {(!Array.isArray(bookings) || (bookings as any).length === 0) && (
                    <div className="text-center py-8 text-muted-foreground text-xs italic">
                      No recent entries found.
                    </div>
                  )}
                </div>

                {/* Desktop Table View (md: and up) */}
                <div className="hidden md:block overflow-x-auto w-full">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-white/10">
                        <TableHead>Customer</TableHead>
                        <TableHead>Station</TableHead>
                        <TableHead>Time</TableHead>
                        <TableHead className="text-right">Price</TableHead>
                        <TableHead className="text-right">Invoice</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {Array.isArray(bookings) && bookings.slice(0, 10).map((booking: any) => (
                        <TableRow key={booking.id} className="border-white/10">
                          <TableCell className="font-medium">{booking.user?.username || 'Guest'}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span>{booking.gameType?.name || (
                                <span className="text-xs text-muted-foreground font-medium bg-white/5 px-2 py-0.5 rounded border border-white/10">
                                  No Category
                                </span>
                              )}</span>
                              {booking.station?.name && (
                                <Badge variant="outline" className="text-[10px] font-mono border-primary/30 text-primary bg-primary/5">
                                  {booking.station.name}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs">
                            {booking.gameTypeId
                              ? `${format(new Date(booking.startTime), "HH:mm")} - ${format(new Date(booking.endTime), "HH:mm")}`
                              : format(new Date(booking.startTime), "HH:mm")}
                          </TableCell>
                          <TableCell className="text-right font-mono text-primary">
                            ₹{(booking.totalPrice / 100).toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                setCurrentBooking(booking);
                                setShowInvoice(true);
                              }}
                              className="touch-target"
                              title="Print Invoice"
                            >
                              <Printer className="w-4 h-4 text-muted-foreground hover:text-foreground" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                      {(!Array.isArray(bookings) || (bookings as any).length === 0) && (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                            No recent entries found.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </CardContent>
        </Card>
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
