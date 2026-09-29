import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { Plus, Users, Clock, DollarSign, History, Loader2, Package, PieChart, Calendar } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/responsive/status-badge";

interface EmployeeStats {
  dailyEntries: number;
  totalEntries: number;
  totalRevenue: number;
}

import type { Booking } from "@shared/schema";
import { useRealtimeUpdates } from "@/lib/realtime";
import { CHANNEL_OPERATIONAL_STAFF, CHANNEL_STATIONS_PUBLIC } from "@shared/realtime";

export default function EmployeeDashboard() {
  const { user } = useAuth();
  const { isConnected } = useRealtimeUpdates({
    channels: [CHANNEL_OPERATIONAL_STAFF, CHANNEL_STATIONS_PUBLIC],
  });
  const { data: stats, isLoading: statsLoading } = useQuery<EmployeeStats>({ queryKey: ["/api/employee/stats"] });
  const { data: bookings, isLoading: bookingsLoading } = useQuery<Booking[]>({ queryKey: ["/api/bookings"] });

  if (statsLoading || bookingsLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-background"><Loader2 className="animate-spin w-12 h-12 text-primary" /></div>;
  }

  const recentEntries = bookings?.filter((b: any) => b.employeeId === user?.id).slice(0, 5) || [];

  return (
    <div className="min-h-full bg-background text-foreground">
      <main className="container mx-auto px-3 sm:px-4 py-6 sm:py-8">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 sm:mb-8">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl sm:text-3xl font-display font-bold tracking-tight">EMPLOYEE <span className="text-primary">DASHBOARD</span></h1>
              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono border ${isConnected ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10" : "border-amber-500/30 text-amber-400 bg-amber-500/10"}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? "bg-emerald-400 animate-pulse" : "bg-amber-400"}`} />
                {isConnected ? "LIVE" : "SYNCING"}
              </span>
            </div>
            <p className="text-muted-foreground mt-1 uppercase text-[10px] tracking-widest">Point of Sale & Session Management</p>
          </div>
          <Link href="/employee/entries" className="w-full sm:w-auto">
            <Button size="lg" className="w-full sm:w-auto bg-primary text-primary-foreground hover:bg-primary/90 hover:shadow-[0_0_20px_rgba(0,243,255,0.4)] transition-all font-display font-bold">
              <Plus className="mr-2 h-5 w-5" /> NEW ENTRY
            </Button>
          </Link>
        </div>

        {/* --- QUICK ACTIONS --- */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 mb-6 sm:mb-8">
          <Link href="/employee">
            <Card className="bg-card/40 backdrop-blur-sm border-primary/20 hover:border-primary/50 transition-all cursor-pointer group relative overflow-hidden h-24">
              <div className="absolute inset-0 bg-primary/5 group-hover:bg-primary/10 transition-colors" />
              <CardContent className="flex items-center gap-4 h-full relative p-6">
                <div className="p-3 rounded-lg bg-primary/20 text-primary border border-primary/30 group-hover:scale-110 transition-transform">
                  <PieChart className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-display font-bold uppercase tracking-tight group-hover:text-primary transition-colors">Global Analytics</h3>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-widest">Station usage and performance</p>
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link href="/employee/entries">
            <Card className="bg-card/40 backdrop-blur-sm border-secondary/20 hover:border-secondary/50 transition-all cursor-pointer group relative overflow-hidden h-24">
              <div className="absolute inset-0 bg-secondary/5 group-hover:bg-secondary/10 transition-colors" />
              <CardContent className="flex items-center gap-4 h-full relative p-6">
                <div className="p-3 rounded-lg bg-secondary/20 text-secondary border border-secondary/30 group-hover:scale-110 transition-transform">
                  <Calendar className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-display font-bold uppercase tracking-tight group-hover:text-secondary transition-colors">Direct Entry Protocol</h3>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-widest">Start new gaming session</p>
                </div>
              </CardContent>
            </Card>
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 sm:gap-6 mb-6 sm:mb-8">
          <Card className="bg-card/40 backdrop-blur-sm border-white/5 hover:border-primary/20 transition-all group">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground group-hover:text-primary transition-colors">DAILY ENTRIES</CardTitle>
              <Users className="w-4 h-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-display font-bold">{stats?.dailyEntries || 0}</div>
              <p className="text-xs text-muted-foreground mt-1">Sessions started today</p>
            </CardContent>
          </Card>

          <Card className="bg-card/40 backdrop-blur-sm border-white/5 hover:border-secondary/20 transition-all group">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground group-hover:text-secondary transition-colors">TOTAL PROCESSED</CardTitle>
              <History className="w-4 h-4 text-secondary" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-display font-bold">{stats?.totalEntries || 0}</div>
              <p className="text-xs text-muted-foreground mt-1">Across all time sessions</p>
            </CardContent>
          </Card>

          <Card className="bg-card/40 backdrop-blur-sm border-white/5 hover:border-accent/20 transition-all group">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground group-hover:text-accent transition-colors">MY REVENUE</CardTitle>
              <DollarSign className="w-4 h-4 text-accent" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-display font-bold text-accent">₹{((stats?.totalRevenue || 0) / 100).toFixed(2)}</div>
              <p className="text-xs text-muted-foreground mt-1">Total billing generated</p>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-display font-bold flex items-center gap-2">
                <Clock className="w-5 h-5 text-primary" />
                RECENT ACTIVITY
              </h2>
              <Link href="/employee/recent">
                <Button variant="ghost" className="text-primary hover:bg-primary/10 text-xs font-semibold px-2.5 h-8">View All</Button>
              </Link>
            </div>
            <Card className="bg-card/40 backdrop-blur-sm border-white/10 overflow-hidden">
              <CardContent className="p-0">
                {/* Mobile Card List (< md:) */}
                <div className="md:hidden divide-y divide-white/5">
                  {recentEntries.map((booking: any) => (
                    <div key={booking.id} className="p-3.5 space-y-2.5 hover:bg-white/[0.02] transition-colors">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-sm text-foreground">{booking.user?.username || 'Guest'}</span>
                        <StatusBadge status={booking.status} />
                      </div>

                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span>{booking.gameType?.name || 'General'}</span>
                          {booking.station?.name && (
                            <Badge variant="outline" className="text-[10px] font-mono border-primary/30 text-primary bg-primary/5">
                              {booking.station.name}
                            </Badge>
                          )}
                        </div>
                        <span className="font-mono text-foreground font-semibold">
                          {format(new Date(booking.startTime), "HH:mm")}
                        </span>
                      </div>

                      <div className="flex items-center justify-between pt-1 border-t border-white/5 text-xs">
                        <span className="text-muted-foreground font-mono text-[11px]">{booking.bookingRef}</span>
                        <span className="font-mono font-bold text-primary text-sm">
                          ₹{(booking.totalPrice / 100).toFixed(2)}
                        </span>
                      </div>
                    </div>
                  ))}
                  {recentEntries.length === 0 && (
                    <div className="text-center py-8 text-muted-foreground text-xs italic">
                      No recent activity recorded by you yet.
                    </div>
                  )}
                </div>

                {/* Desktop Table View (md: and up) */}
                <div className="hidden md:block overflow-x-auto w-full">
                  <Table>
                    <TableHeader className="bg-white/5">
                      <TableRow className="border-white/5 hover:bg-transparent">
                        <TableHead className="font-display text-xs">CUSTOMER</TableHead>
                        <TableHead className="font-display text-xs">GAME TYPE</TableHead>
                        <TableHead className="font-display text-xs">START TIME</TableHead>
                        <TableHead className="text-right font-display text-xs">AMOUNT</TableHead>
                        <TableHead className="text-right font-display text-xs">STATUS</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recentEntries.map((booking: any) => (
                        <TableRow key={booking.id} className="border-white/5 hover:bg-white/5 transition-colors">
                          <TableCell className="font-semibold">{booking.user?.username || 'Guest'}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full bg-primary/50" />
                              <span>{booking.gameType?.name || 'General'}</span>
                              {booking.station?.name && (
                                <Badge variant="outline" className="text-[10px] font-mono border-primary/30 text-primary bg-primary/5">
                                  {booking.station.name}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground font-mono text-sm">
                            {format(new Date(booking.startTime), "HH:mm")}
                          </TableCell>
                          <TableCell className="text-right font-mono font-bold text-primary">
                            ₹{(booking.totalPrice / 100).toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right">
                            <StatusBadge status={booking.status} />
                          </TableCell>
                        </TableRow>
                      ))}
                      {recentEntries.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center py-12 text-muted-foreground italic">
                            No recent activity recorded by you yet.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </section>
        </div>
      </main>
    </div>
  );
}
