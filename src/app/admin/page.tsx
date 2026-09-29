"use client";

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
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Plus, Pencil, Trash2, Check, X, DollarSign, Users, Calendar, AlertCircle } from "lucide-react";
import { format } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";

interface AdminStats {
  totalRevenue: number;
  totalBookings: number;
  revenueSplit: { online: number; offline: number };
  employeeStats: { username: string; revenue: number }[];
}

export default function AdminDashboard() {
  const { user, isLoading: authLoading } = useAuth();
  const { bookings, updateBookingStatus, startTimer, stopTimer, isLoading: bookingsLoading } = useBookings();
  const { gameTypes, createGameType, updateGameType, deleteGameType, isLoading: gamesLoading } = useGameTypes();
  const { data: allUsers, isLoading: usersLoading } = useQuery({ queryKey: ["/api/admin/users"] });
  const { data: stats, isLoading: statsLoading } = useQuery<AdminStats>({ queryKey: ["/api/admin/stats/comprehensive"] });
  const router = useRouter();
  const { toast } = useToast();

  // --- STATE ---
  const [now, setNow] = useState(new Date());
  const [newGame, setNewGame] = useState({ name: "", description: "", hourlyPrice: "", maxPlayers: "", imageUrl: "", priceModel: "flat" });
  const [editingGame, setEditingGame] = useState<any>(null);
  const [isGameDialogOpen, setIsGameDialogOpen] = useState(false);
  const [isEditGameDialogOpen, setIsEditGameDialogOpen] = useState(false);
  const [filterDate, setFilterDate] = useState("");
  const [filterGameType, setFilterGameType] = useState("");

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
      const pendingBookings = bookings.filter((b: any) => b.status === "Pending");
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
      bookings.forEach((b: any) => {
        if (b.timerStartedAt && b.status === "Approved") {
          const end = new Date(b.endTime);
          if (end.getTime() <= now.getTime() && !notifiedTimers.has(b.id)) {
            toast({
              title: "⏰ SESSION TIME UP!",
              description: `Session at ${b.gameType?.name || "station"} for ${b.user?.username || "Guest"} has ended.`,
              variant: "destructive",
              className: "animate-bounce shadow-[0_0_20px_rgba(239,68,68,0.5)]",
            });
            setNotifiedTimers((prev) => {
              const next = new Set(prev);
              next.add(b.id);
              return next;
            });
          }
        }
      });
    }
  }, [bookings, now, lastPendingCount, notifiedTimers, toast]);

  useEffect(() => {
    if (!authLoading && (!user || user.role !== "admin")) {
      router.replace("/");
    }
  }, [user, authLoading, router]);

  if (authLoading || bookingsLoading || gamesLoading || usersLoading || statsLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="animate-spin w-12 h-12 text-primary" />
      </div>
    );
  }

  if (!user || user.role !== "admin") {
    return null;
  }

  // --- LIVE TIMER LOGIC ---
  const getTimerDisplay = (booking: any) => {
    if (!booking.timerStartedAt || booking.status === "Completed" || booking.status === "Cancelled") return null;

    const end = new Date(booking.endTime);
    const diff = end.getTime() - now.getTime();

    if (diff <= 0) return <Badge className="bg-red-500 animate-pulse">TIME UP</Badge>;

    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return (
      <div className="font-mono text-primary font-bold">
        {mins}:{secs.toString().padStart(2, "0")}
      </div>
    );
  };

  const totalRevenue = stats?.totalRevenue || 0;
  const totalBookings = stats?.totalBookings || 0;
  const activeGames = gameTypes?.length || 0;

  // Chart Data
  const bookingsByDay = bookings?.reduce((acc: any, curr: any) => {
    try {
      const date = format(new Date(curr.startTime), "MM/dd");
      acc[date] = (acc[date] || 0) + 1;
    } catch (e) {
      console.error("Invalid date in booking", curr);
    }
    return acc;
  }, {});

  const chartData = Object.entries(bookingsByDay || {}).map(([date, count]) => ({ date, bookings: count }));

  const revenueSplitData = [
    { name: "Online", value: stats?.revenueSplit?.online || 0 },
    { name: "Offline", value: stats?.revenueSplit?.offline || 0 },
  ];
  const COLORS = ["#0088FE", "#00C49F"];

  const handleCreateGame = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await (createGameType as any).mutateAsync({
        name: newGame.name,
        description: newGame.description,
        imageUrl: newGame.imageUrl || "/assets/PLAY_N_SLAY_LOGO__1768593233107.jpeg",
        hourlyPrice: parseInt(newGame.hourlyPrice, 10),
        maxPlayers: parseInt(newGame.maxPlayers, 10),
        priceModel: newGame.priceModel,
        isActive: true,
      });
      setIsGameDialogOpen(false);
      setNewGame({ name: "", description: "", hourlyPrice: "", maxPlayers: "", imageUrl: "", priceModel: "flat" });
    } catch (error) {
      // Handled by hook
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
        hourlyPrice: parseInt(editingGame.hourlyPrice.toString(), 10),
        maxPlayers: parseInt(editingGame.maxPlayers, 10),
        imageUrl: editingGame.imageUrl,
        priceModel: editingGame.priceModel,
      });
      setIsEditGameDialogOpen(false);
      setEditingGame(null);
    } catch (error) {}
  };

  const handleDeleteGame = async (id: number) => {
    if (confirm("Are you sure? This will remove the station from active booking.")) {
      deleteGameType.mutate(id);
    }
  };

  const filteredBookings = bookings?.filter((b: any) => {
    const matchesDate = !filterDate || format(new Date(b.startTime), "yyyy-MM-dd") === filterDate;
    const matchesGame = !filterGameType || b.gameTypeId.toString() === filterGameType;
    return matchesDate && matchesGame;
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navbar />

      <main className="container mx-auto px-4 pt-24 pb-12">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-display font-bold uppercase tracking-tighter">
              Admin Console{" "}
              <span className="text-primary text-xs ml-2 px-2 py-0.5 rounded border border-primary/20 bg-primary/10">
                COMMAND CENTER
              </span>
            </h1>
            <p className="text-muted-foreground uppercase text-[10px] tracking-[0.2em] mt-1">
              System Overview &amp; Station Management
            </p>
          </div>
        </div>

        {/* --- STATS CARDS --- */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <Card className="bg-card/50 border-white/10">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Revenue</CardTitle>
              <DollarSign className="w-4 h-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-display text-primary">₹{totalRevenue}</div>
            </CardContent>
          </Card>
          <Card className="bg-card/50 border-white/10">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Bookings</CardTitle>
              <Calendar className="w-4 h-4 text-secondary" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-display">{totalBookings}</div>
            </CardContent>
          </Card>
          <Card className="bg-card/50 border-white/10">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Active Stations</CardTitle>
              <Users className="w-4 h-4 text-accent" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-display">{activeGames}</div>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList className="bg-card border border-white/10">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="analytics">Analytics</TabsTrigger>
            <TabsTrigger value="bookings">Bookings</TabsTrigger>
            <TabsTrigger value="games">Station Management</TabsTrigger>
            <TabsTrigger value="users">User Management</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <Card className="bg-card/50 border-white/10">
              <CardHeader>
                <CardTitle>Booking Traffic Activity</CardTitle>
              </CardHeader>
              <CardContent className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                    <XAxis dataKey="date" stroke="#888" />
                    <YAxis stroke="#888" />
                    <Tooltip contentStyle={{ backgroundColor: "#1a1a2e", borderColor: "#333", color: "#fff" }} />
                    <Bar dataKey="bookings" fill="hsl(180, 100%, 50%)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="analytics" className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card className="bg-card/50 border-white/10">
                <CardHeader>
                  <CardTitle>Revenue Split</CardTitle>
                  <CardDescription>Online vs In-Lounge Counter Revenue</CardDescription>
                </CardHeader>
                <CardContent className="h-[300px] flex justify-center">
                  <ResponsiveContainer width="100%" height="100%">
                    <RechartsPieChart>
                      <Pie
                        data={revenueSplitData}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={80}
                        fill="#8884d8"
                        paddingAngle={5}
                        dataKey="value"
                      >
                        {revenueSplitData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ backgroundColor: "#1a1a2e", borderColor: "#333" }} />
                      <Legend />
                    </RechartsPieChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <Card className="bg-card/50 border-white/10">
                <CardHeader>
                  <CardTitle>Employee Performance</CardTitle>
                  <CardDescription>Revenue processed by staff members</CardDescription>
                </CardHeader>
                <CardContent className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={stats?.employeeStats || []} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                      <XAxis type="number" stroke="#888" />
                      <YAxis dataKey="username" type="category" stroke="#888" width={120} />
                      <Tooltip contentStyle={{ backgroundColor: "#1a1a2e", borderColor: "#333" }} />
                      <Bar dataKey="revenue" fill="#82ca9d" radius={[0, 4, 4, 0]} name="Revenue (₹)" />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="bookings">
            <Card className="bg-card/50 border-white/10">
              <CardHeader>
                <div className="flex justify-between items-center">
                  <div>
                    <CardTitle>Session Reservations</CardTitle>
                    <CardDescription>Manage approval status of incoming reservations.</CardDescription>
                  </div>
                  <div className="flex gap-4">
                    <Input
                      type="date"
                      className="w-40 bg-background/50 border-white/10"
                      value={filterDate}
                      onChange={(e) => setFilterDate(e.target.value)}
                    />
                    <select
                      className="bg-background/50 border border-white/10 rounded-md p-1 text-sm text-muted-foreground"
                      value={filterGameType}
                      onChange={(e) => setFilterGameType(e.target.value)}
                    >
                      <option value="">All Stations</option>
                      {gameTypes?.map((g: any) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/10 hover:bg-white/5">
                      <TableHead>Ref</TableHead>
                      <TableHead>User</TableHead>
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
                    {filteredBookings
                      ?.sort((a: any, b: any) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime())
                      .map((booking: any) => (
                        <TableRow key={booking.id} className="border-white/10 hover:bg-white/5">
                          <TableCell className="font-mono text-xs">{booking.bookingRef}</TableCell>
                          <TableCell>{booking.user?.username || "Guest"}</TableCell>
                          <TableCell>{booking.gameType?.name || "Station"}</TableCell>
                          <TableCell>{format(new Date(booking.startTime), "MM/dd/yyyy")}</TableCell>
                          <TableCell>
                            {format(new Date(booking.startTime), "HH:mm")} - {format(new Date(booking.endTime), "HH:mm")}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="capitalize">
                              {booking.paymentMethod}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={
                                booking.status === "Pending"
                                  ? "text-yellow-400 border-yellow-500/50"
                                  : booking.status === "Approved"
                                  ? "text-green-400 border-green-500/50"
                                  : booking.status === "Cancelled"
                                  ? "text-red-400 border-red-500/50"
                                  : "text-blue-400 border-blue-500/50"
                              }
                            >
                              {booking.status}
                            </Badge>
                          </TableCell>
                          <TableCell>{getTimerDisplay(booking)}</TableCell>
                          <TableCell className="text-right space-x-2">
                            {booking.status === "Pending" && (
                              <>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-green-400 hover:text-green-300 hover:bg-green-400/10"
                                  onClick={() => updateBookingStatus.mutate({ id: booking.id, status: "Approved" })}
                                >
                                  <Check className="w-4 h-4" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-red-400 hover:text-red-300 hover:bg-red-400/10"
                                  onClick={() => updateBookingStatus.mutate({ id: booking.id, status: "Cancelled" })}
                                >
                                  <X className="w-4 h-4" />
                                </Button>
                              </>
                            )}
                            {booking.status === "Approved" && !booking.timerStartedAt && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 border-primary/50 text-primary hover:bg-primary/10"
                                onClick={() => (startTimer as any).mutate(booking.id)}
                              >
                                Start Timer
                              </Button>
                            )}
                            {booking.timerStartedAt && booking.status !== "Completed" && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 border-red-500/50 text-red-400 hover:bg-red-500/10"
                                onClick={() => (stopTimer as any).mutate(booking.id)}
                              >
                                Stop Timer
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="games">
            <div className="flex justify-end mb-4">
              <Dialog open={isGameDialogOpen} onOpenChange={setIsGameDialogOpen}>
                <DialogTrigger asChild>
                  <Button className="bg-primary text-primary-foreground hover:bg-primary/90">
                    <Plus className="mr-2 h-4 w-4" /> Add Gaming Station
                  </Button>
                </DialogTrigger>
                <DialogContent className="bg-card border-white/10">
                  <DialogHeader>
                    <DialogTitle>New Gaming Station Setup</DialogTitle>
                  </DialogHeader>
                  <form onSubmit={handleCreateGame} className="space-y-4">
                    <div>
                      <Label>Station Name</Label>
                      <Input
                        value={newGame.name}
                        onChange={(e) => setNewGame({ ...newGame, name: e.target.value })}
                        required
                        className="bg-background/50 border-white/10"
                      />
                    </div>
                    <div>
                      <Label>Description</Label>
                      <Input
                        value={newGame.description}
                        onChange={(e) => setNewGame({ ...newGame, description: e.target.value })}
                        className="bg-background/50 border-white/10"
                      />
                    </div>
                    <div>
                      <Label>Image URL</Label>
                      <Input
                        value={newGame.imageUrl}
                        placeholder="/assets/PLAY_N_SLAY_LOGO__1768593233107.jpeg"
                        onChange={(e) => setNewGame({ ...newGame, imageUrl: e.target.value })}
                        className="bg-background/50 border-white/10"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>Hourly Price (₹)</Label>
                        <Input
                          type="number"
                          value={newGame.hourlyPrice}
                          onChange={(e) => setNewGame({ ...newGame, hourlyPrice: e.target.value })}
                          required
                          className="bg-background/50 border-white/10"
                        />
                      </div>
                      <div>
                        <Label>Price Model</Label>
                        <select
                          className="w-full bg-background/50 border border-white/10 rounded-md p-2 text-sm"
                          value={newGame.priceModel}
                          onChange={(e) => setNewGame({ ...newGame, priceModel: e.target.value })}
                        >
                          <option value="flat">Flat Price</option>
                          <option value="per_player">Per Player</option>
                        </select>
                      </div>
                      <div>
                        <Label>Max Players</Label>
                        <Input
                          type="number"
                          value={newGame.maxPlayers}
                          onChange={(e) => setNewGame({ ...newGame, maxPlayers: e.target.value })}
                          required
                          className="bg-background/50 border-white/10"
                        />
                      </div>
                    </div>
                    <Button type="submit" className="w-full bg-primary text-primary-foreground">
                      Create Station
                    </Button>
                  </form>
                </DialogContent>
              </Dialog>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {gameTypes?.map((game: any) => (
                <Card key={game.id} className="bg-card/50 border-white/10">
                  <div className="flex flex-row">
                    <div className="w-1/3 h-full">
                      <img
                        src={game.imageUrl || "/assets/PLAY_N_SLAY_LOGO__1768593233107.jpeg"}
                        alt={game.name}
                        className="h-full w-full object-cover rounded-l-lg aspect-square"
                      />
                    </div>
                    <div className="w-2/3 p-4 flex flex-col justify-between">
                      <div>
                        <h3 className="font-bold text-lg">{game.name}</h3>
                        <p className="text-sm text-muted-foreground">{game.description}</p>
                        <div className="mt-2 text-sm">
                          <span className="text-primary font-bold">₹{game.hourlyPrice}/hr</span> • {game.maxPlayers} Players Max
                        </div>
                      </div>
                      <div className="flex justify-end gap-2 mt-4">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingGame(game);
                            setIsEditGameDialogOpen(true);
                          }}
                          className="text-primary hover:bg-primary/10"
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteGame(game.id)}
                          className="text-destructive hover:bg-destructive/10"
                        >
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
                      <Input
                        value={editingGame?.name || ""}
                        onChange={(e) => setEditingGame({ ...editingGame, name: e.target.value })}
                        required
                        className="bg-background/50 border-white/10"
                      />
                    </div>
                    <div>
                      <Label>Description</Label>
                      <Input
                        value={editingGame?.description || ""}
                        onChange={(e) => setEditingGame({ ...editingGame, description: e.target.value })}
                        className="bg-background/50 border-white/10"
                      />
                    </div>
                    <div>
                      <Label>Image URL</Label>
                      <Input
                        value={editingGame?.imageUrl || ""}
                        onChange={(e) => setEditingGame({ ...editingGame, imageUrl: e.target.value })}
                        className="bg-background/50 border-white/10"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>Hourly Price (₹)</Label>
                        <Input
                          type="number"
                          value={editingGame?.hourlyPrice || ""}
                          onChange={(e) => setEditingGame({ ...editingGame, hourlyPrice: e.target.value })}
                          required
                          className="bg-background/50 border-white/10"
                        />
                      </div>
                      <div>
                        <Label>Price Model</Label>
                        <select
                          className="w-full bg-background/50 border border-white/10 rounded-md p-2 text-sm"
                          value={editingGame?.priceModel || "flat"}
                          onChange={(e) => setEditingGame({ ...editingGame, priceModel: e.target.value })}
                        >
                          <option value="flat">Flat Price</option>
                          <option value="per_player">Per Player</option>
                        </select>
                      </div>
                      <div>
                        <Label>Max Players</Label>
                        <Input
                          type="number"
                          value={editingGame?.maxPlayers || ""}
                          onChange={(e) => setEditingGame({ ...editingGame, maxPlayers: e.target.value })}
                          required
                          className="bg-background/50 border-white/10"
                        />
                      </div>
                    </div>
                    <Button type="submit" className="w-full bg-primary text-primary-foreground">
                      Save Changes
                    </Button>
                  </form>
                </DialogContent>
              </Dialog>
            </div>
          </TabsContent>

          <TabsContent value="users">
            <Card className="bg-card/50 border-white/10">
              <CardHeader>
                <CardTitle>User &amp; Role Management</CardTitle>
                <CardDescription>View all registered members and system staff accounts.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/10 hover:bg-white/5">
                      <TableHead>Username / Email</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Account Status</TableHead>
                      <TableHead>Registered</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(allUsers as any[])?.map((u) => (
                      <TableRow key={u.id} className="border-white/10 hover:bg-white/5">
                        <TableCell className="font-medium">{u.username}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {u.role === "admin" ? (
                              <Badge className="bg-red-500/20 text-red-400 border-red-500/50">Admin</Badge>
                            ) : u.role === "employee" ? (
                              <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/50">Employee</Badge>
                            ) : (
                              <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/50">Member</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-green-400 border-green-500/50">
                            Active
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {u.createdAt ? format(new Date(u.createdAt), "MM/dd/yyyy") : "N/A"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
