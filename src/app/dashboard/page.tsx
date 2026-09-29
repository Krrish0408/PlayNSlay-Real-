"use client";

import { useAuth } from "@/hooks/use-auth";
import { useBookings } from "@/hooks/use-bookings";
import { Navbar } from "@/components/layout-navbar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Calendar, Clock, Monitor } from "lucide-react";
import { format } from "date-fns";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect } from "react";

export default function DashboardPage() {
  const { user, isLoading: authLoading } = useAuth();
  const { bookings, isLoading: bookingsLoading } = useBookings();
  const router = useRouter();

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace("/auth");
    }
  }, [user, authLoading, router]);

  if (authLoading || bookingsLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-12 h-12 text-primary animate-spin" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const userBookings = bookings?.filter((b: any) => b.userId === user.id) || [];
  const upcomingBookings = userBookings.filter((b: any) => new Date(b.startTime) > new Date());
  const pastBookings = userBookings.filter((b: any) => new Date(b.startTime) <= new Date());

  const getStatusColor = (status: string) => {
    switch (status) {
      case "Approved":
        return "bg-green-500/20 text-green-400 border-green-500/50";
      case "Pending":
        return "bg-yellow-500/20 text-yellow-400 border-yellow-500/50";
      case "Cancelled":
        return "bg-red-500/20 text-red-400 border-red-500/50";
      case "Completed":
        return "bg-blue-500/20 text-blue-400 border-blue-500/50";
      default:
        return "bg-gray-500/20 text-gray-400";
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navbar />

      <main className="container mx-auto px-4 pt-24 pb-12">
        <div className="mb-8">
          <h1 className="text-3xl font-display font-bold mb-2">My Command Center</h1>
          <p className="text-muted-foreground">Manage your upcoming sessions and view reservation history.</p>
        </div>

        <Tabs defaultValue="upcoming" className="space-y-6">
          <TabsList className="bg-card border border-white/10">
            <TabsTrigger value="upcoming">Upcoming Sessions</TabsTrigger>
            <TabsTrigger value="history">Session History</TabsTrigger>
          </TabsList>

          <TabsContent value="upcoming" className="space-y-4">
            {upcomingBookings.length === 0 ? (
              <Card className="bg-card/50 border-white/10 border-dashed">
                <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                    <Calendar className="w-8 h-8 text-primary" />
                  </div>
                  <h3 className="text-xl font-bold mb-2">No upcoming sessions</h3>
                  <p className="text-muted-foreground mb-6">You haven&apos;t booked any gaming time yet.</p>
                  <Link href="/#booking-section" className="text-primary hover:underline font-bold">
                    Book a station now &rarr;
                  </Link>
                </CardContent>
              </Card>
            ) : (
              upcomingBookings.map((booking: any) => (
                <BookingCard key={booking.id} booking={booking} getStatusColor={getStatusColor} />
              ))
            )}
          </TabsContent>

          <TabsContent value="history" className="space-y-4">
            {pastBookings.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">No past history found.</div>
            ) : (
              pastBookings.map((booking: any) => (
                <BookingCard key={booking.id} booking={booking} getStatusColor={getStatusColor} />
              ))
            )}
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

function BookingCard({ booking, getStatusColor }: any) {
  return (
    <Card className="bg-card/50 border-white/10 hover:border-primary/30 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex justify-between items-start">
          <div>
            <CardTitle className="font-display tracking-wide mb-1 flex items-center gap-2">
              <Monitor className="w-5 h-5 text-primary" />
              {booking.gameType?.name || "Gaming Station"}
            </CardTitle>
            <CardDescription className="font-mono text-xs text-muted-foreground">
              REF: {booking.bookingRef}
            </CardDescription>
          </div>
          <Badge className={`${getStatusColor(booking.status)} border px-3 py-1 uppercase tracking-wider font-bold`}>
            {booking.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div className="flex items-center text-muted-foreground">
            <Calendar className="w-4 h-4 mr-2" />
            {format(new Date(booking.startTime), "PPP")}
          </div>
          <div className="flex items-center text-muted-foreground">
            <Clock className="w-4 h-4 mr-2" />
            {format(new Date(booking.startTime), "p")} - {format(new Date(booking.endTime), "p")}
          </div>
          <div className="flex items-center font-bold text-foreground">
            ₹{booking.totalPrice}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
