"use client";

import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Plus, Users, Clock, DollarSign, History, Loader2, PieChart, Calendar } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { Booking } from "@/shared/schema";

interface EmployeeStats {
  dailyEntries: number;
  totalEntries: number;
  totalRevenue: number;
}

export default function EmployeeDashboard() {
  const { user } = useAuth();
  const { data: stats, isLoading: statsLoading } = useQuery<EmployeeStats>({
    queryKey: ["/api/employee/stats"],
  });
  const { data: bookings, isLoading: bookingsLoading } = useQuery<Booking[]>({
    queryKey: ["/api/bookings"],
  });

  if (statsLoading || bookingsLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="animate-spin w-12 h-12 text-primary" />
      </div>
    );
  }

  const recentEntries = bookings?.filter((b: any) => b.employeeId === user?.id).slice(0, 5) || [];

  return (
    <div className="space-y-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold tracking-tight">
            EMPLOYEE <span className="text-primary">DASHBOARD</span>
          </h1>
          <p className="text-muted-foreground mt-1 uppercase text-[10px] tracking-widest">
            Point of Sale &amp; Session Management
          </p>
        </div>
        <Link href="/employee/entries">
          <Button
            size="lg"
            className="bg-primary text-primary-foreground hover:bg-primary/90 hover:shadow-[0_0_20px_rgba(0,243,255,0.4)] transition-all font-display font-bold"
          >
            <Plus className="mr-2 h-5 w-5" /> NEW ENTRY
          </Button>
        </Link>
      </div>

      {/* --- QUICK ACTIONS --- */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Link href="/employee">
          <Card className="bg-card/40 backdrop-blur-sm border-primary/20 hover:border-primary/50 transition-all cursor-pointer group relative overflow-hidden h-24">
            <div className="absolute inset-0 bg-primary/5 group-hover:bg-primary/10 transition-colors" />
            <CardContent className="flex items-center gap-4 h-full relative p-6">
              <div className="p-3 rounded-lg bg-primary/20 text-primary border border-primary/30 group-hover:scale-110 transition-transform">
                <PieChart className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-display font-bold uppercase tracking-tight group-hover:text-primary transition-colors">
                  Live Operations
                </h3>
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest">
                  Station overview and POS control
                </p>
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
                <h3 className="font-display font-bold uppercase tracking-tight group-hover:text-secondary transition-colors">
                  Direct Entry Protocol
                </h3>
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest">
                  Start new gaming session &amp; snacks
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="bg-card/40 backdrop-blur-sm border-white/5 hover:border-primary/20 transition-all group">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground group-hover:text-primary transition-colors">
              DAILY ENTRIES
            </CardTitle>
            <Users className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-display font-bold">{stats?.dailyEntries || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Sessions started today</p>
          </CardContent>
        </Card>

        <Card className="bg-card/40 backdrop-blur-sm border-white/5 hover:border-secondary/20 transition-all group">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground group-hover:text-secondary transition-colors">
              TOTAL PROCESSED
            </CardTitle>
            <History className="w-4 h-4 text-secondary" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-display font-bold">{stats?.totalEntries || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Across all time sessions</p>
          </CardContent>
        </Card>

        <Card className="bg-card/40 backdrop-blur-sm border-white/5 hover:border-accent/20 transition-all group">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground group-hover:text-accent transition-colors">
              MY REVENUE
            </CardTitle>
            <DollarSign className="w-4 h-4 text-accent" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-display font-bold text-accent">₹{stats?.totalRevenue || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Total counter billing processed</p>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-display font-bold flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" />
            RECENT ACTIVITY
          </h2>
          <Link href="/employee/recent">
            <Button variant="ghost" className="text-primary hover:bg-primary/10">
              View All History
            </Button>
          </Link>
        </div>
        <Card className="bg-card/40 backdrop-blur-sm border-white/10 overflow-hidden">
          <CardContent className="p-0">
            <Table>
              <TableHeader className="bg-white/5">
                <TableRow className="border-white/5 hover:bg-transparent">
                  <TableHead className="font-display text-xs">CUSTOMER</TableHead>
                  <TableHead className="font-display text-xs">STATION</TableHead>
                  <TableHead className="font-display text-xs">START TIME</TableHead>
                  <TableHead className="text-right font-display text-xs">AMOUNT</TableHead>
                  <TableHead className="text-right font-display text-xs">STATUS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentEntries.map((booking: any) => (
                  <TableRow key={booking.id} className="border-white/5 hover:bg-white/5 transition-colors">
                    <TableCell className="font-semibold">{booking.user?.username || "Walk-in Guest"}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-primary/50" />
                        {booking.gameType?.name}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-sm">
                      {format(new Date(booking.startTime), "HH:mm")}
                    </TableCell>
                    <TableCell className="text-right font-mono font-bold text-primary">
                      ₹{booking.totalPrice}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant="outline"
                        className="text-xs bg-green-500/10 text-green-400 border-green-500/30 font-display"
                      >
                        {booking.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
                {recentEntries.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-12 text-muted-foreground italic">
                      No recent entries recorded by you yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
