import { useAuth } from "@/hooks/use-auth";
import { useBookings } from "@/hooks/use-bookings";
import { useGameTypes } from "@/hooks/use-game-types";
import { Navbar } from "@/components/layout-navbar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";
import { useLocation, Redirect, Link } from "wouter";
import { Loader2, Plus, Pencil, Trash2, Check, X, DollarSign, Users, Calendar, ShieldCheck, PieChart, AlertCircle, KeyRound, Wrench, Power, CheckCircle2, AlertTriangle, Monitor } from "lucide-react";
import { format } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import { ImageUpload } from "@/components/image-upload";


import { useGames } from "@/hooks/use-games";
import { useStations } from "@/hooks/use-stations";
import type { StationStatus } from "@shared/schema";
import { resolveGameCover } from "@/lib/game-images";
import { useRealtimeUpdates } from "@/lib/realtime";
import { CHANNEL_OPERATIONAL_STAFF, CHANNEL_STATIONS_PUBLIC } from "@shared/realtime";

interface AdminStats {
  totalRevenue: number;
  totalBookings: number;
  revenueSplit: { online: number; offline: number };
  employeeStats: { username: string; revenue: number }[];
}

export default function AdminDashboard() {
  const { user, isLoading: authLoading } = useAuth();
  const { isConnected } = useRealtimeUpdates({
    channels: [CHANNEL_OPERATIONAL_STAFF, CHANNEL_STATIONS_PUBLIC],
  });
  const { bookings, updateBookingStatus, startTimer, stopTimer, isLoading: bookingsLoading } = useBookings();
  const { gameTypes, createGameType, updateGameType, deleteGameType, isLoading: gamesLoading } = useGameTypes();
  const { games, createGame, updateGame, deleteGame } = useGames();
  const { stations, createStation, updateStationStatus, deleteStation, isLoading: stationsLoading } = useStations();
  const { data: allUsers, isLoading: usersLoading } = useQuery({ queryKey: ["/api/admin/users"] });
  const { data: stats, isLoading: statsLoading } = useQuery<AdminStats>({ queryKey: ["/api/admin/stats/comprehensive"] });
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  // --- STATE ---
  const [now, setNow] = useState(new Date());
  const [newGame, setNewGame] = useState({ name: "", description: "", hourlyPrice: "", maxPlayers: "", imageUrl: "", priceModel: "flat" });
  const [editingGame, setEditingGame] = useState<any>(null);
  const [isGameDialogOpen, setIsGameDialogOpen] = useState(false);
  const [isEditGameDialogOpen, setIsEditGameDialogOpen] = useState(false);

  // Stations State
  const [stationFilterGameType, setStationFilterGameType] = useState("");
  const [isStationDialogOpen, setIsStationDialogOpen] = useState(false);
  const [newStation, setNewStation] = useState<{ name: string; gameTypeId: string; status: StationStatus }>({
    name: "",
    gameTypeId: "",
    status: "AVAILABLE",
  });

  // Catalog Game State
  const [catalogSearch, setCatalogSearch] = useState("");
  const [newCatalogGame, setNewCatalogGame] = useState({ title: "", platforms: "PS4, PS5", minPlayers: "1", maxPlayers: "1", genre: "Action", imageUrl: "" });
  const [editingCatalogGame, setEditingCatalogGame] = useState<any>(null);
  const [isCatalogDialogOpen, setIsCatalogDialogOpen] = useState(false);
  const [isEditCatalogDialogOpen, setIsEditCatalogDialogOpen] = useState(false);
  const [filterDate, setFilterDate] = useState("");
  const [filterGameType, setFilterGameType] = useState("");
  const [resetPasswordUser, setResetPasswordUser] = useState<any>(null);
  const [newPasswordInput, setNewPasswordInput] = useState("");
  const [isResettingPassword, setIsResettingPassword] = useState(false);

  // --- NOTIFICATION LOGIC ---
  const [lastPendingCount, setLastPendingCount] = useState<number | null>(null);
  const [notifiedTimers, setNotifiedTimers] = useState<Set<number>>(new Set());

  // Update clock
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (bookings) {
      const pendingBookings = bookings.filter(b => b.status === "Pending");
      if (lastPendingCount !== null && pendingBookings.length > lastPendingCount) {
        toast({
          title: "🔔 New Booking Arrival!",
          description: "A new reservation is waiting for your approval.",
          className: "bg-primary text-primary-foreground border-none shadow-[0_0_20px_rgba(0,243,255,0.5)]",
        });
      }
      if (pendingBookings.length !== lastPendingCount) {
        setLastPendingCount(pendingBookings.length);
      }

      // Timer completion notifications
      bookings.forEach(b => {
        if (b.timerStartedAt && b.status === "Approved") {
          const end = new Date(b.endTime);
          if (end.getTime() <= now.getTime() && !notifiedTimers.has(b.id)) {
            toast({
              title: "⏰ SESSION TIME UP!",
              description: `Session at ${b.gameType?.name || "station"} for ${b.user?.username || "Guest"} has ended.`,
              variant: "destructive",
              className: "animate-bounce shadow-[0_0_20px_rgba(239,68,68,0.5)]",
            });
            setNotifiedTimers(prev => {
              const next = new Set(prev);
              next.add(b.id);
              return next;
            });
          }
        }
      });
    }
  }, [bookings, now, lastPendingCount, notifiedTimers, toast]);

  if (authLoading || bookingsLoading || gamesLoading || usersLoading || statsLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-background"><Loader2 className="animate-spin w-12 h-12 text-primary" /></div>;
  }

  if (!user || user.role !== "admin") {
    return <Redirect to="/" />;
  }

  // --- LIVE TIMER LOGIC ---
  const getTimerDisplay = (booking: any) => {
    if (!booking.timerStartedAt || booking.status === 'Completed' || booking.status === 'Cancelled') return null;

    const start = new Date(booking.timerStartedAt);
    const end = new Date(booking.endTime);
    const diff = end.getTime() - now.getTime();

    if (diff <= 0) return <Badge className="bg-red-500 animate-pulse">TIME UP</Badge>;

    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return (
      <div className="font-mono text-primary font-bold">
        {mins}:{secs.toString().padStart(2, '0')}
      </div>
    );
  };

  // --- STATS CALCULATION ---
  const totalRevenue = stats?.totalRevenue || 0;
  const totalBookings = stats?.totalBookings || 0;
  const activeGames = gameTypes?.length || 0;



  // --- HANDLERS ---
  const handleCreateGame = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await (createGameType as any).mutateAsync({
        name: newGame.name,
        description: newGame.description,
        imageUrl: newGame.imageUrl,
        hourlyPrice: Math.round(parseFloat(newGame.hourlyPrice) * 100),
        maxPlayers: parseInt(newGame.maxPlayers),
        priceModel: newGame.priceModel,
        isActive: true
      });
      setIsGameDialogOpen(false);
      setNewGame({ name: "", description: "", hourlyPrice: "", maxPlayers: "", imageUrl: "", priceModel: "flat" });
    } catch (error) {
      // handled by hook
    }
  };

  const handleUpdateGame = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingGame) return;
    try {
      await (updateGameType as any).mutateAsync({
        id: editingGame.id,
        name: editingGame.name,
        description: editingGame.description,
        hourlyPrice: Math.round(parseFloat(editingGame.hourlyPrice.toString()) * 100),
        maxPlayers: parseInt(editingGame.maxPlayers),
        imageUrl: editingGame.imageUrl,
        priceModel: editingGame.priceModel
      });
      setIsEditGameDialogOpen(false);
      setEditingGame(null);
    } catch (error) { }
  };

  const handleDeleteGame = async (id: number) => {
    if (confirm("Are you sure? This will hide the game from booking.")) {
      deleteGameType.mutate(id);
    }
  };

  const handleCreateCatalogGame = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCatalogGame.title) return;
    await createGame.mutateAsync({
      title: newCatalogGame.title,
      platforms: newCatalogGame.platforms,
      minPlayers: parseInt(newCatalogGame.minPlayers) || 1,
      maxPlayers: parseInt(newCatalogGame.maxPlayers) || 1,
      genre: newCatalogGame.genre || "Action",
      isActive: true,
      imageUrl: newCatalogGame.imageUrl || null,
    });
    setNewCatalogGame({ title: "", platforms: "PS4, PS5", minPlayers: "1", maxPlayers: "1", genre: "Action", imageUrl: "" });
    setIsCatalogDialogOpen(false);
  };

  const handleUpdateCatalogGame = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCatalogGame) return;
    await updateGame.mutateAsync({
      id: editingCatalogGame.id,
      title: editingCatalogGame.title,
      platforms: editingCatalogGame.platforms,
      minPlayers: parseInt(editingCatalogGame.minPlayers) || 1,
      maxPlayers: parseInt(editingCatalogGame.maxPlayers) || 1,
      genre: editingCatalogGame.genre,
      imageUrl: editingCatalogGame.imageUrl || null,
    });
    setEditingCatalogGame(null);
    setIsEditCatalogDialogOpen(false);
  };

  const handleResetUserPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetPasswordUser) return;

    try {
      setIsResettingPassword(true);
      const res = await fetch(`/api/admin/users/${resetPasswordUser.id}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to initiate password reset");

      toast({
        title: "Secure Reset Initiated 🔒",
        description: data.message || `Active sessions invalidated and recovery email sent to ${resetPasswordUser.username}.`,
      });
      setResetPasswordUser(null);
      setNewPasswordInput("");
    } catch (err: any) {
      toast({
        title: "Reset Failed",
        description: err.message || "Could not initiate password reset.",
        variant: "destructive"
      });
    } finally {
      setIsResettingPassword(false);
    }
  };

  const handleCreateStation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStation.name.trim() || !newStation.gameTypeId) {
      toast({
        title: "Validation Error",
        description: "Please specify a station name and select a game category.",
        variant: "destructive",
      });
      return;
    }
    try {
      await createStation.mutateAsync({
        name: newStation.name.trim(),
        gameTypeId: parseInt(newStation.gameTypeId),
        status: newStation.status,
      });
      setNewStation({ name: "", gameTypeId: "", status: "AVAILABLE" });
      setIsStationDialogOpen(false);
    } catch (err) {
      // toast shown in hook
    }
  };

  const filteredStations = stations?.filter((s) => {
    if (!stationFilterGameType) return true;
    return s.gameTypeId.toString() === stationFilterGameType;
  });

  const filteredBookings = bookings?.filter(b => {
    const matchesDate = !filterDate || format(new Date(b.startTime), "yyyy-MM-dd") === filterDate;
    const matchesGame = !filterGameType || b.gameTypeId?.toString() === filterGameType;
    return matchesDate && matchesGame;
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navbar />

      <main className="container mx-auto px-4 pt-24 pb-12">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 sm:mb-8">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl sm:text-3xl font-display font-bold uppercase tracking-tighter">Admin Console <span className="text-primary text-xs ml-2 px-2 py-0.5 rounded border border-primary/20 bg-primary/10">MISSION CONTROL</span></h1>
              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono border ${isConnected ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10" : "border-amber-500/30 text-amber-400 bg-amber-500/10"}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? "bg-emerald-400 animate-pulse" : "bg-amber-400"}`} />
                {isConnected ? "LIVE" : "SYNCING"}
              </span>
            </div>
            <p className="text-muted-foreground uppercase text-[10px] tracking-[0.2em] mt-1">System Overview and Strategic Management</p>
          </div>
          <Button variant="outline" onClick={() => window.open("/api/admin/bookings/export", "_blank")} className="w-full sm:w-auto border-white/10 hover:bg-white/5 font-display text-xs tracking-widest uppercase">
            <Plus className="mr-2 h-4 w-4" /> Export Data (CSV)
          </Button>
        </div>

        {/* --- STATS CARDS --- */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 sm:gap-6 mb-6 sm:mb-8">
          <Card className="bg-card/50 border-white/10">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Revenue</CardTitle>
              <DollarSign className="w-4 h-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">₹{(totalRevenue / 100).toFixed(2)}</div>
            </CardContent>
          </Card>
          <Card className="bg-card/50 border-white/10">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Bookings</CardTitle>
              <Calendar className="w-4 h-4 text-secondary" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalBookings}</div>
            </CardContent>
          </Card>
          <Card className="bg-card/50 border-white/10">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Physical Stations</CardTitle>
              <Monitor className="w-4 h-4 text-accent" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {stations?.filter(s => s.status === 'AVAILABLE').length || 0}
                <span className="text-sm font-normal text-muted-foreground ml-1.5">/ {stations?.length || 0} online</span>
              </div>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="bookings" className="space-y-6">
          <div className="overflow-x-auto pb-1">
            <TabsList className="bg-card border border-white/10 w-max sm:w-auto">
              <TabsTrigger value="bookings">Bookings</TabsTrigger>
              <TabsTrigger value="stations">Physical Stations ({stations?.length || 0})</TabsTrigger>
              <TabsTrigger value="games">Game Management</TabsTrigger>
              <TabsTrigger value="catalog">Games Catalog ({games?.length || 0})</TabsTrigger>
              <TabsTrigger value="users">User Management</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="bookings">
            <Card className="bg-card/50 border-white/10">
              <CardHeader>
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                  <div>
                    <CardTitle className="text-lg sm:text-xl">Recent Bookings</CardTitle>
                    <CardDescription>Manage approval status of incoming reservations.</CardDescription>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2 sm:gap-4 w-full sm:w-auto">
                    <Input
                      type="date"
                      className="w-full sm:w-40 bg-background/50 border-white/10"
                      value={filterDate}
                      onChange={e => setFilterDate(e.target.value)}
                    />
                    <select
                      className="w-full sm:w-auto bg-background/50 border border-white/10 rounded-md p-2 text-sm text-muted-foreground"
                      value={filterGameType}
                      onChange={e => setFilterGameType(e.target.value)}
                    >
                      <option value="">All Games</option>
                      {gameTypes?.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto w-full">
                  <Table>
                  <TableHeader>
                    <TableRow className="border-white/10 hover:bg-white/5">
                      <TableHead>Ref</TableHead>
                      <TableHead>User</TableHead>
                      <TableHead>Game</TableHead>
                      <TableHead>Station</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead>Payment</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Timer</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredBookings?.sort((a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime()).map((booking) => (
                      <TableRow key={booking.id} className="border-white/10 hover:bg-white/5">
                        <TableCell className="font-mono text-xs">{booking.bookingRef}</TableCell>
                        <TableCell>{booking.user?.username || 'Unknown'}</TableCell>
                        <TableCell>{booking.gameType?.name || 'Unknown'}</TableCell>
                        <TableCell>
                          {booking.station?.name ? (
                            <Badge variant="outline" className="border-cyan-500/40 text-cyan-400 bg-cyan-950/20 font-mono text-xs">
                              {booking.station.name}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs italic">—</span>
                          )}
                        </TableCell>
                        <TableCell>{format(new Date(booking.startTime), "MM/dd/yyyy")}</TableCell>
                        <TableCell>{format(new Date(booking.startTime), "HH:mm")} - {format(new Date(booking.endTime), "HH:mm")}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="capitalize">
                            {booking.paymentMethod}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={
                            booking.status === 'Pending' ? "text-yellow-400 border-yellow-500/50" :
                              booking.status === 'Approved' ? "text-green-400 border-green-500/50" :
                                booking.status === 'Cancelled' ? "text-red-400 border-red-500/50" :
                                  "text-blue-400 border-blue-500/50"
                          }>
                            {booking.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {getTimerDisplay(booking)}
                        </TableCell>
                        <TableCell className="text-right space-x-2">
                          {booking.status === 'Pending' && (
                            <>
                              <Button size="icon" variant="ghost" className="h-8 w-8 text-green-400 hover:text-green-300 hover:bg-green-400/10" onClick={() => updateBookingStatus.mutate({ id: booking.id, status: "Approved" })}>
                                <Check className="w-4 h-4" />
                              </Button>
                              <Button size="icon" variant="ghost" className="h-8 w-8 text-red-400 hover:text-red-300 hover:bg-red-400/10" onClick={() => updateBookingStatus.mutate({ id: booking.id, status: "Cancelled" })}>
                                <X className="w-4 h-4" />
                              </Button>
                            </>
                          )}
                          {booking.status === 'Approved' && !booking.timerStartedAt && (
                            <Button size="sm" variant="outline" className="h-8 border-primary/50 text-primary hover:bg-primary/10" onClick={() => (startTimer as any).mutate(booking.id)}>
                              Start Timer
                            </Button>
                          )}
                          {booking.timerStartedAt && booking.status !== 'Completed' && (
                            <Button size="sm" variant="outline" className="h-8 border-red-500/50 text-red-400 hover:bg-red-500/10" onClick={() => (stopTimer as any).mutate(booking.id)}>
                              Stop Timer
                            </Button>
                          )}
                          {booking.status === 'Approved' && !booking.timerStartedAt && (
                            <Button size="icon" variant="ghost" className="h-8 w-8 text-blue-400 hover:text-blue-300 hover:bg-blue-400/10" onClick={() => updateBookingStatus.mutate({ id: booking.id, status: "Completed" })}>
                              <Check className="w-4 h-4" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="stations">
            <Card className="bg-card/50 border-white/10">
              <CardHeader>
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                  <div>
                    <CardTitle className="text-lg sm:text-xl flex items-center gap-2">
                      <Monitor className="w-5 h-5 text-primary" />
                      Physical Gaming Stations
                    </CardTitle>
                    <CardDescription>
                      Manage individual hardware stations, monitor availability, and toggle operational states (AVAILABLE, MAINTENANCE, INACTIVE).
                    </CardDescription>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2 sm:gap-4 w-full sm:w-auto items-stretch sm:items-center">
                    <select
                      className="w-full sm:w-auto bg-background/50 border border-white/10 rounded-md p-2 text-sm text-muted-foreground"
                      value={stationFilterGameType}
                      onChange={e => setStationFilterGameType(e.target.value)}
                    >
                      <option value="">All Categories</option>
                      {gameTypes?.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>

                    <Dialog open={isStationDialogOpen} onOpenChange={setIsStationDialogOpen}>
                      <DialogTrigger asChild>
                        <Button className="bg-primary text-primary-foreground hover:bg-primary/90 font-display text-xs tracking-wider uppercase">
                          <Plus className="mr-2 h-4 w-4" /> Add Station
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="bg-card border-white/10 sm:max-w-md">
                        <DialogHeader>
                          <DialogTitle className="flex items-center gap-2">
                            <Monitor className="w-5 h-5 text-primary" />
                            Add Physical Station
                          </DialogTitle>
                        </DialogHeader>
                        <form onSubmit={handleCreateStation} className="space-y-4 pt-2">
                          <div>
                            <Label className="text-xs">Station Identifier / Name</Label>
                            <Input
                              placeholder="e.g. PS5-05, PC-09, VR-03"
                              value={newStation.name}
                              onChange={e => setNewStation({ ...newStation, name: e.target.value })}
                              required
                              className="bg-background/50 border-white/10 mt-1"
                            />
                          </div>

                          <div>
                            <Label className="text-xs">Game Category</Label>
                            <select
                              className="w-full bg-background/50 border border-white/10 rounded-md p-2 text-sm mt-1 text-foreground"
                              value={newStation.gameTypeId}
                              onChange={e => setNewStation({ ...newStation, gameTypeId: e.target.value })}
                              required
                            >
                              <option value="">Select a Category...</option>
                              {gameTypes?.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                            </select>
                          </div>

                          <div>
                            <Label className="text-xs">Initial Status</Label>
                            <select
                              className="w-full bg-background/50 border border-white/10 rounded-md p-2 text-sm mt-1 text-foreground"
                              value={newStation.status}
                              onChange={e => setNewStation({ ...newStation, status: e.target.value as StationStatus })}
                            >
                              <option value="AVAILABLE">AVAILABLE (Ready for Auto-Assignment)</option>
                              <option value="MAINTENANCE">MAINTENANCE (Hardware servicing)</option>
                              <option value="INACTIVE">INACTIVE (Powered down / offline)</option>
                            </select>
                          </div>

                          <div className="flex justify-end gap-2 pt-2">
                            <Button type="button" variant="ghost" onClick={() => setIsStationDialogOpen(false)}>
                              Cancel
                            </Button>
                            <Button type="submit" disabled={createStation.isPending} className="bg-primary text-primary-foreground">
                              {createStation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                              Create Station
                            </Button>
                          </div>
                        </form>
                      </DialogContent>
                    </Dialog>
                  </div>
                </div>

                {/* Status overview cards */}
                <div className="grid grid-cols-3 gap-3 pt-4 border-t border-white/10">
                  <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-center">
                    <div className="text-xs uppercase text-green-400 font-mono tracking-wider">Available</div>
                    <div className="text-xl font-bold text-green-400 mt-1">
                      {stations?.filter(s => s.status === 'AVAILABLE').length || 0}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-center">
                    <div className="text-xs uppercase text-yellow-400 font-mono tracking-wider">Maintenance</div>
                    <div className="text-xl font-bold text-yellow-400 mt-1">
                      {stations?.filter(s => s.status === 'MAINTENANCE').length || 0}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-center">
                    <div className="text-xs uppercase text-red-400 font-mono tracking-wider">Inactive</div>
                    <div className="text-xl font-bold text-red-400 mt-1">
                      {stations?.filter(s => s.status === 'INACTIVE').length || 0}
                    </div>
                  </div>
                </div>
              </CardHeader>

              <CardContent>
                <div className="overflow-x-auto w-full">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-white/10 hover:bg-white/5">
                        <TableHead>Station ID</TableHead>
                        <TableHead>Identifier</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead>Current Status</TableHead>
                        <TableHead>Change Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredStations?.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                            No physical stations found. Click "Add Station" to register physical hardware.
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredStations?.map((station) => {
                          const category = gameTypes?.find(g => g.id === station.gameTypeId);
                          return (
                            <TableRow key={station.id} className="border-white/10 hover:bg-white/5">
                              <TableCell className="font-mono text-xs text-muted-foreground">#{station.id}</TableCell>
                              <TableCell className="font-mono font-bold text-sm text-cyan-400">
                                {station.name}
                              </TableCell>
                              <TableCell className="font-medium">
                                {category?.name || `Category #${station.gameTypeId}`}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className={
                                    station.status === 'AVAILABLE'
                                      ? "text-green-400 border-green-500/50 bg-green-500/10"
                                      : station.status === 'MAINTENANCE'
                                      ? "text-yellow-400 border-yellow-500/50 bg-yellow-500/10"
                                      : "text-red-400 border-red-500/50 bg-red-500/10"
                                  }
                                >
                                  {station.status}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-1.5">
                                  <Button
                                    size="sm"
                                    variant={station.status === 'AVAILABLE' ? "default" : "outline"}
                                    className={`h-7 text-xs px-2 ${
                                      station.status === 'AVAILABLE'
                                        ? "bg-green-600 hover:bg-green-500 text-white"
                                        : "border-green-500/30 text-green-400 hover:bg-green-500/10"
                                    }`}
                                    onClick={() => updateStationStatus.mutate({ id: station.id, status: 'AVAILABLE' })}
                                    disabled={updateStationStatus.isPending || station.status === 'AVAILABLE'}
                                    title="Set station to AVAILABLE"
                                  >
                                    <CheckCircle2 className="w-3 h-3 mr-1" /> Available
                                  </Button>

                                  <Button
                                    size="sm"
                                    variant={station.status === 'MAINTENANCE' ? "default" : "outline"}
                                    className={`h-7 text-xs px-2 ${
                                      station.status === 'MAINTENANCE'
                                        ? "bg-yellow-600 hover:bg-yellow-500 text-white"
                                        : "border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10"
                                    }`}
                                    onClick={() => updateStationStatus.mutate({ id: station.id, status: 'MAINTENANCE' })}
                                    disabled={updateStationStatus.isPending || station.status === 'MAINTENANCE'}
                                    title="Set station to MAINTENANCE"
                                  >
                                    <Wrench className="w-3 h-3 mr-1" /> Maintenance
                                  </Button>

                                  <Button
                                    size="sm"
                                    variant={station.status === 'INACTIVE' ? "default" : "outline"}
                                    className={`h-7 text-xs px-2 ${
                                      station.status === 'INACTIVE'
                                        ? "bg-red-600 hover:bg-red-500 text-white"
                                        : "border-red-500/30 text-red-400 hover:bg-red-500/10"
                                    }`}
                                    onClick={() => updateStationStatus.mutate({ id: station.id, status: 'INACTIVE' })}
                                    disabled={updateStationStatus.isPending || station.status === 'INACTIVE'}
                                    title="Set station to INACTIVE"
                                  >
                                    <Power className="w-3 h-3 mr-1" /> Inactive
                                  </Button>
                                </div>
                              </TableCell>
                              <TableCell className="text-right">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-red-400 hover:text-red-300 hover:bg-red-400/10"
                                  onClick={() => {
                                    if (confirm(`Are you sure you want to delete station ${station.name}?`)) {
                                      deleteStation.mutate(station.id);
                                    }
                                  }}
                                  title="Delete Station"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="games">
            <div className="flex justify-end mb-4">
              <Dialog open={isGameDialogOpen} onOpenChange={setIsGameDialogOpen}>
                <DialogTrigger asChild>
                  <Button className="bg-primary text-primary-foreground hover:bg-primary/90">
                    <Plus className="mr-2 h-4 w-4" /> Add Station Type
                  </Button>
                </DialogTrigger>
                <DialogContent className="bg-card border-white/10">
                  <DialogHeader>
                    <DialogTitle>New Game Station</DialogTitle>
                  </DialogHeader>
                  <form onSubmit={handleCreateGame} className="space-y-4">
                    <div>
                      <Label>Name</Label>
                      <Input value={newGame.name} onChange={e => setNewGame({ ...newGame, name: e.target.value })} required className="bg-background/50 border-white/10" />
                    </div>
                    <div>
                      <Label>Description</Label>
                      <Input value={newGame.description} onChange={e => setNewGame({ ...newGame, description: e.target.value })} className="bg-background/50 border-white/10" />
                    </div>
                    <ImageUpload
                      label="Station Photo (Cloudinary)"
                      value={newGame.imageUrl}
                      onChange={(url) => setNewGame({ ...newGame, imageUrl: url })}
                    />
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>Hourly Price (₹)</Label>
                        <Input type="number" value={newGame.hourlyPrice} onChange={e => setNewGame({ ...newGame, hourlyPrice: e.target.value })} required className="bg-background/50 border-white/10" />
                      </div>
                      <div>
                        <Label>Price Model</Label>
                        <select
                          className="w-full bg-background/50 border border-white/10 rounded-md p-2 text-sm"
                          value={(newGame as any).priceModel || "flat"}
                          onChange={e => setNewGame({ ...newGame, priceModel: e.target.value } as any)}
                        >
                          <option value="flat">Flat Price</option>
                          <option value="per_player">Per Player</option>
                        </select>
                      </div>
                      <div>
                        <Label>Max Players</Label>
                        <Input type="number" value={newGame.maxPlayers} onChange={e => setNewGame({ ...newGame, maxPlayers: e.target.value })} required className="bg-background/50 border-white/10" />
                      </div>
                    </div>
                    <Button type="submit" className="w-full bg-primary text-primary-foreground">Create Station</Button>
                  </form>
                </DialogContent>
              </Dialog>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {gameTypes?.map(game => (
                <Card key={game.id} className="bg-card/50 border-white/10">
                  <div className="flex flex-row">
                    <div className="w-1/3 h-full">
                      <img src={game.imageUrl || ""} alt={game.name} className="h-full w-full object-cover rounded-l-lg aspect-square" />
                    </div>
                    <div className="w-2/3 p-4 flex flex-col justify-between">
                      <div>
                        <h3 className="font-bold text-lg">{game.name}</h3>
                        <p className="text-sm text-muted-foreground">{game.description}</p>
                        <div className="mt-2 text-sm">
                          <span className="text-primary font-bold">₹{(game.hourlyPrice / 100).toFixed(2)}/hr</span> • {game.maxPlayers} Players Max
                        </div>
                      </div>
                      <div className="flex justify-end gap-2 mt-4">
                        <Button variant="ghost" size="sm" onClick={() => {
                          setEditingGame({
                            ...game,
                            hourlyPrice: game.hourlyPrice / 100
                          });
                          setIsEditGameDialogOpen(true);
                        }} className="text-primary hover:bg-primary/10">
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDeleteGame(game.id)} className="text-destructive hover:bg-destructive/10">
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}

              <Dialog open={isEditGameDialogOpen} onOpenChange={setIsEditGameDialogOpen}>
                <DialogContent className="bg-card border-white/10">
                  <DialogHeader>
                    <DialogTitle>Edit Game Station</DialogTitle>
                  </DialogHeader>
                  <form onSubmit={handleUpdateGame} className="space-y-4">
                    <div>
                      <Label>Name</Label>
                      <Input value={editingGame?.name || ""} onChange={e => setEditingGame({ ...editingGame, name: e.target.value })} required className="bg-background/50 border-white/10" />
                    </div>
                    <div>
                      <Label>Description</Label>
                      <Input value={editingGame?.description || ""} onChange={e => setEditingGame({ ...editingGame, description: e.target.value })} className="bg-background/50 border-white/10" />
                    </div>
                    <ImageUpload
                      label="Station Photo (Cloudinary)"
                      value={editingGame?.imageUrl || ""}
                      onChange={(url) => setEditingGame({ ...editingGame, imageUrl: url })}
                    />
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>Hourly Price (₹)</Label>
                        <Input type="number" value={editingGame?.hourlyPrice || ""} onChange={e => setEditingGame({ ...editingGame, hourlyPrice: e.target.value })} required className="bg-background/50 border-white/10" />
                      </div>
                      <div>
                        <Label>Price Model</Label>
                        <select
                          className="w-full bg-background/50 border border-white/10 rounded-md p-2 text-sm"
                          value={editingGame?.priceModel || "flat"}
                          onChange={e => setEditingGame({ ...editingGame, priceModel: e.target.value })}
                        >
                          <option value="flat">Flat Price</option>
                          <option value="per_player">Per Player</option>
                        </select>
                      </div>
                      <div>
                        <Label>Max Players</Label>
                        <Input type="number" value={editingGame?.maxPlayers || ""} onChange={e => setEditingGame({ ...editingGame, maxPlayers: e.target.value })} required className="bg-background/50 border-white/10" />
                      </div>
                    </div>
                    <Button type="submit" className="w-full bg-primary text-primary-foreground">Save Changes</Button>
                  </form>
                </DialogContent>
              </Dialog>
            </div>
          </TabsContent>

          {/* --- GAMES CATALOG TAB --- */}
          <TabsContent value="catalog" className="space-y-6">
            <Card className="bg-card/50 border-white/10">
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-xl font-bold">Games Catalog ({games?.length || 0})</CardTitle>
                  <CardDescription>Manage game titles, station compatibility (PS4, PS5, Racing Sim, VR), and player counts.</CardDescription>
                </div>
                <Dialog open={isCatalogDialogOpen} onOpenChange={setIsCatalogDialogOpen}>
                  <DialogTrigger asChild>
                    <Button className="bg-primary text-primary-foreground font-display text-xs tracking-widest uppercase">
                      <Plus className="mr-2 h-4 w-4" /> Add Game Title
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="bg-card border-white/10 max-w-lg">
                    <DialogHeader>
                      <DialogTitle>Add Game to Catalog</DialogTitle>
                    </DialogHeader>
                    <form onSubmit={handleCreateCatalogGame} className="space-y-4">
                      <div>
                        <Label>Game Title</Label>
                        <Input 
                          placeholder="e.g. GTA 5, FIFA 24, WWE 2K24" 
                          value={newCatalogGame.title} 
                          onChange={e => setNewCatalogGame({ ...newCatalogGame, title: e.target.value })} 
                          required 
                          className="bg-background/50 border-white/10" 
                        />
                      </div>
                      <div>
                        <Label>Platforms / Stations</Label>
                        <Input 
                          placeholder="e.g. PS4, PS5 or PS5, Racing Sim" 
                          value={newCatalogGame.platforms} 
                          onChange={e => setNewCatalogGame({ ...newCatalogGame, platforms: e.target.value })} 
                          required 
                          className="bg-background/50 border-white/10" 
                        />
                        <p className="text-xs text-muted-foreground mt-1">Specify platforms like: PS4, PS5, Racing Sim, VR</p>
                      </div>
                      <ImageUpload
                        label="Game Cover Photo (Cloudinary)"
                        value={newCatalogGame.imageUrl}
                        onChange={(url) => setNewCatalogGame({ ...newCatalogGame, imageUrl: url })}
                      />
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label>Max Players</Label>
                          <select
                            className="w-full bg-background/50 border border-white/10 rounded-md p-2 text-sm text-foreground"
                            value={newCatalogGame.maxPlayers}
                            onChange={e => setNewCatalogGame({ ...newCatalogGame, maxPlayers: e.target.value })}
                          >
                            <option value="1">1 Player (1P)</option>
                            <option value="2">2 Players (1P, 2P)</option>
                            <option value="3">3 Players (1P - 3P)</option>
                            <option value="4">4 Players (1P - 4P)</option>
                          </select>
                        </div>
                        <div>
                          <Label>Genre / Category</Label>
                          <Input 
                            placeholder="e.g. Action, Sports, Racing" 
                            value={newCatalogGame.genre} 
                            onChange={e => setNewCatalogGame({ ...newCatalogGame, genre: e.target.value })} 
                            className="bg-background/50 border-white/10" 
                          />
                        </div>
                      </div>
                      <Button type="submit" className="w-full bg-primary text-primary-foreground font-bold">Add Game</Button>
                    </form>
                  </DialogContent>
                </Dialog>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-4">
                  <Input
                    placeholder="Search game titles or stations..."
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                    className="max-w-sm bg-background/50 border-white/10"
                  />
                  <Badge variant="outline" className="border-primary/30 text-primary">
                    Showing {games?.filter(g => g.title.toLowerCase().includes(catalogSearch.toLowerCase()) || g.platforms.toLowerCase().includes(catalogSearch.toLowerCase())).length || 0} games
                  </Badge>
                </div>

                <div className="rounded-md border border-white/10 overflow-x-auto w-full">
                  <Table>
                    <TableHeader className="bg-white/5">
                      <TableRow className="border-white/10">
                        <TableHead className="w-12">#</TableHead>
                        <TableHead className="w-16">Cover</TableHead>
                        <TableHead>Game Title</TableHead>
                        <TableHead>Supported Stations</TableHead>
                        <TableHead>Max Players</TableHead>
                        <TableHead>Genre</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {games
                        ?.filter(g => g.title.toLowerCase().includes(catalogSearch.toLowerCase()) || g.platforms.toLowerCase().includes(catalogSearch.toLowerCase()))
                        .map((game, idx) => (
                          <TableRow key={game.id} className="border-white/10 hover:bg-white/5">
                            <TableCell className="font-mono text-xs text-muted-foreground">{idx + 1}</TableCell>
                            <TableCell>
                              <img
                                src={resolveGameCover(game.title, game.imageUrl, game.genre, game.platforms)}
                                alt={game.title}
                                className="w-10 h-10 object-cover rounded-md border border-white/10"
                              />
                            </TableCell>
                            <TableCell className="font-semibold text-foreground">{game.title}</TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                {game.platforms.split(',').map((p, i) => (
                                  <Badge key={i} variant="secondary" className="bg-primary/10 text-primary border-primary/20 text-[11px]">
                                    {p.trim()}
                                  </Badge>
                                ))}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="border-emerald-500/40 text-emerald-400 text-xs">
                                {game.maxPlayers === 1 ? "1P (Single Player)" : `1P - ${game.maxPlayers}P (${game.maxPlayers} Players)`}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="border-white/20 text-muted-foreground text-xs">
                                {game.genre || "General"}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-2">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setEditingCatalogGame(game);
                                    setIsEditCatalogDialogOpen(true);
                                  }}
                                  className="text-primary hover:bg-primary/10 h-8 w-8 p-0"
                                >
                                  <Pencil className="w-4 h-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    if (confirm(`Remove "${game.title}" from catalog?`)) {
                                      deleteGame.mutate(game.id);
                                    }
                                  }}
                                  className="text-destructive hover:bg-destructive/10 h-8 w-8 p-0"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            {/* Edit Catalog Game Dialog */}
            <Dialog open={isEditCatalogDialogOpen} onOpenChange={setIsEditCatalogDialogOpen}>
              <DialogContent className="bg-card border-white/10 max-w-lg">
                <DialogHeader>
                  <DialogTitle>Edit Catalog Game</DialogTitle>
                </DialogHeader>
                {editingCatalogGame && (
                  <form onSubmit={handleUpdateCatalogGame} className="space-y-4">
                    <div>
                      <Label>Game Title</Label>
                      <Input
                        value={editingCatalogGame.title}
                        onChange={e => setEditingCatalogGame({ ...editingCatalogGame, title: e.target.value })}
                        required
                        className="bg-background/50 border-white/10"
                      />
                    </div>
                    <div>
                      <Label>Platforms / Stations</Label>
                      <Input
                        value={editingCatalogGame.platforms}
                        onChange={e => setEditingCatalogGame({ ...editingCatalogGame, platforms: e.target.value })}
                        required
                        className="bg-background/50 border-white/10"
                      />
                    </div>
                    <ImageUpload
                      label="Game Cover Photo (Cloudinary)"
                      value={editingCatalogGame.imageUrl || ""}
                      onChange={(url) => setEditingCatalogGame({ ...editingCatalogGame, imageUrl: url })}
                    />
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>Max Players</Label>
                        <select
                          className="w-full bg-background/50 border border-white/10 rounded-md p-2 text-sm text-foreground"
                          value={editingCatalogGame.maxPlayers}
                          onChange={e => setEditingCatalogGame({ ...editingCatalogGame, maxPlayers: e.target.value })}
                        >
                          <option value="1">1 Player (1P)</option>
                          <option value="2">2 Players (1P, 2P)</option>
                          <option value="3">3 Players (1P - 3P)</option>
                          <option value="4">4 Players (1P - 4P)</option>
                        </select>
                      </div>
                      <div>
                        <Label>Genre / Category</Label>
                        <Input
                          value={editingCatalogGame.genre || ""}
                          onChange={e => setEditingCatalogGame({ ...editingCatalogGame, genre: e.target.value })}
                          className="bg-background/50 border-white/10"
                        />
                      </div>
                    </div>
                    <Button type="submit" className="w-full bg-primary text-primary-foreground font-bold">Save Changes</Button>
                  </form>
                )}
              </DialogContent>
            </Dialog>
          </TabsContent>

          <TabsContent value="users">
            <Card className="bg-card/50 border-white/10">
              <CardHeader>
                <CardTitle>User Management</CardTitle>
                <CardDescription>View all registered gamers and system staff.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto w-full">
                  <Table>
                  <TableHeader>
                    <TableRow className="border-white/10 hover:bg-white/5">
                      <TableHead>Username</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Joined Date</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(allUsers as any[])?.map((u) => (
                      <TableRow key={u.id} className="border-white/10 hover:bg-white/5">
                        <TableCell className="font-medium">{u.username}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {u.role === 'admin' ? (
                              <Badge className="bg-red-500/20 text-red-400 border-red-500/50">Admin</Badge>
                            ) : u.role === 'employee' ? (
                              <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/50">Employee</Badge>
                            ) : (
                              <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/50">Member</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-green-400 border-green-500/50">Active</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {u.createdAt ? (() => {
                            try {
                              return format(new Date(u.createdAt), "MM/dd/yyyy");
                            } catch (e) {
                              return "Invalid Date";
                            }
                          })() : "N/A"}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setResetPasswordUser(u);
                              setNewPasswordInput("");
                            }}
                            className="border-white/10 hover:border-primary/40 hover:bg-primary/10 text-xs gap-1.5 h-7 px-2.5"
                          >
                            <KeyRound className="w-3.5 h-3.5 text-primary" />
                            <span>Reset Password</span>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

            {/* Force Password Reset Modal */}
            <Dialog open={!!resetPasswordUser} onOpenChange={(open) => !open && setResetPasswordUser(null)}>
              <DialogContent className="bg-card border-white/10 sm:max-w-md">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <KeyRound className="w-5 h-5 text-primary" />
                    Force Password Reset for {resetPasswordUser?.username}
                  </DialogTitle>
                </DialogHeader>
                <form onSubmit={handleResetUserPassword} className="space-y-4 pt-2">
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-200">
                    <p className="font-semibold mb-1">Secure Password Recovery Protocol</p>
                    <p className="text-xs text-amber-300/80 leading-relaxed">
                      In accordance with security standards, administrators cannot view or choose user passwords.
                      Submitting will immediately invalidate all active sessions for <strong>{resetPasswordUser?.username}</strong>, mark the account as requiring a password reset, and dispatch a secure recovery link.
                    </p>
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <Button type="button" variant="ghost" onClick={() => setResetPasswordUser(null)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={isResettingPassword} className="bg-destructive hover:bg-destructive/90 text-white">
                      {isResettingPassword ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                      Force Reset & Invalidate Sessions
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}