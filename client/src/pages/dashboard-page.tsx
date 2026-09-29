import { useAuth } from "@/hooks/use-auth";
import { useBookings } from "@/hooks/use-bookings";
import { Navbar } from "@/components/layout-navbar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Calendar, Clock, Monitor, User, Settings, Sparkles, Gamepad2, Plus } from "lucide-react";
import { formatLoungeDate, formatLoungeTime, getTimezoneAbbr, getLoungeTimezone } from "@/lib/timezone";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { ProfileModal } from "@/components/profile-modal";
import { useState } from "react";
import { StatusBadge } from "@/components/responsive/status-badge";
import { EmptyState } from "@/components/responsive/empty-state";
import { LoadingSkeleton } from "@/components/responsive/loading-skeleton";

export default function DashboardPage() {
  const { user, isLoading: authLoading } = useAuth();
  const { bookings, isLoading: bookingsLoading } = useBookings();
  const [, setLocation] = useLocation();
  const [isProfileOpen, setIsProfileOpen] = useState(false);

  if (authLoading || bookingsLoading) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <Navbar />
        <main className="container mx-auto px-3 sm:px-4 pt-20 sm:pt-24 pb-28 md:pb-12 space-y-6">
          <LoadingSkeleton type="metrics" count={1} />
          <LoadingSkeleton type="booking" count={3} />
        </main>
      </div>
    );
  }

  if (!user) {
    setLocation("/auth");
    return null;
  }

  const userBookings = bookings?.filter(b => b.userId === user.id) || [];
  const upcomingBookings = userBookings.filter(b => new Date(b.startTime) > new Date());
  const pastBookings = userBookings.filter(b => new Date(b.startTime) <= new Date());

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navbar />
      
      <main className="container mx-auto px-3 sm:px-4 pt-20 sm:pt-24 pb-28 md:pb-12">
        {/* User Profile Card */}
        <div className="mb-6 sm:mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-4 sm:p-6 rounded-2xl border border-white/10 bg-card/60 backdrop-blur-md shadow-lg">
          <div className="flex items-center gap-3 sm:gap-4 min-w-0">
            <div className="w-12 h-12 sm:w-16 sm:h-16 shrink-0 rounded-full overflow-hidden border-2 border-primary/50 bg-background/50 flex items-center justify-center text-primary font-bold text-base sm:text-xl shadow-[0_0_15px_rgba(0,243,255,0.2)]">
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt={user.username} className="w-full h-full object-cover" />
              ) : (
                user.username.substring(0, 2).toUpperCase()
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg sm:text-2xl font-display font-bold truncate">{user.fullName || user.username}</h1>
                <Badge variant="outline" className="border-primary/40 text-primary bg-primary/10 capitalize text-xs">
                  {user.role}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground truncate mt-0.5">@{user.username} {user.email ? `• ${user.email}` : ""}</p>
            </div>
          </div>

          <div className="flex items-center justify-between sm:justify-end gap-3 pt-3 sm:pt-0 border-t sm:border-t-0 border-white/5">
            <div className="px-3 py-1.5 rounded-lg border border-white/10 bg-background/50 text-left sm:text-right">
              <span className="text-[10px] uppercase text-muted-foreground block font-semibold">Tier</span>
              <span className="text-xs sm:text-sm font-bold text-primary capitalize flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5" />
                {user.membershipTier || "Bronze"}
              </span>
            </div>
            <Button
              variant="outline"
              onClick={() => setIsProfileOpen(true)}
              className="border-white/10 hover:border-primary/50 hover:bg-primary/10 gap-1.5 text-xs h-10 px-3 touch-target"
            >
              <Settings className="w-4 h-4 text-primary" />
              <span>Edit Profile</span>
            </Button>
            <Button
              onClick={() => setLocation("/#booking-section")}
              className="bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5 text-xs h-10 px-3.5 font-bold shadow-[0_0_15px_rgba(0,243,255,0.3)] touch-target"
            >
              <Plus className="w-4 h-4" />
              <span>Book Station</span>
            </Button>
          </div>
        </div>

        <Tabs defaultValue="upcoming" className="space-y-6">
          <TabsList className="bg-card border border-white/10 w-full sm:w-auto grid grid-cols-2 sm:inline-flex h-11">
            <TabsTrigger value="upcoming" className="text-xs sm:text-sm">
              Upcoming ({upcomingBookings.length})
            </TabsTrigger>
            <TabsTrigger value="history" className="text-xs sm:text-sm">
              History ({pastBookings.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="upcoming" className="space-y-4">
            {upcomingBookings.length === 0 ? (
              <EmptyState
                icon={Calendar}
                title="No Upcoming Gaming Sessions"
                description="You don't have any upcoming reservations. Pick your favorite gaming station and jump in."
                actionLabel="Book a Station Now"
                onAction={() => setLocation("/#booking-section")}
              />
            ) : (
              upcomingBookings.map((booking) => (
                <BookingCard key={booking.id} booking={booking} onBookAgain={() => setLocation("/#booking-section")} />
              ))
            )}
          </TabsContent>

          <TabsContent value="history" className="space-y-4">
             {pastBookings.length === 0 ? (
               <EmptyState
                 icon={Gamepad2}
                 title="No Past Missions Logged"
                 description="Your completed and cancelled gaming sessions will appear here for your reference."
                 actionLabel="Explore Stations"
                 onAction={() => setLocation("/games")}
               />
             ) : (
               pastBookings.map((booking) => (
                <BookingCard key={booking.id} booking={booking} onBookAgain={() => setLocation("/#booking-section")} />
              ))
             )}
          </TabsContent>
        </Tabs>
      </main>
      <ProfileModal open={isProfileOpen} onOpenChange={setIsProfileOpen} />
    </div>
  );
}

function BookingCard({ booking, onBookAgain }: { booking: any; onBookAgain?: () => void }) {
  return (
    <Card className="bg-card/50 border-white/10 hover:border-primary/30 transition-all rounded-xl overflow-hidden shadow-sm">
      <CardHeader className="p-4 sm:p-5 pb-2.5">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-2.5">
          <div className="min-w-0">
            <CardTitle className="font-display tracking-wide mb-1 flex items-center gap-2 text-base sm:text-lg flex-wrap">
              <Monitor className="w-4 h-4 sm:w-5 sm:h-5 text-primary shrink-0" />
              <span className="truncate">{booking.gameType?.name || "Gaming Session"}</span>
              {booking.station?.name && (
                <Badge variant="outline" className="font-mono text-[10px] bg-primary/10 text-primary border-primary/30 uppercase tracking-wider">
                  {booking.station.name}
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="font-mono text-xs text-muted-foreground">
              REF: {booking.bookingRef}
            </CardDescription>
          </div>
          <div className="self-start sm:self-auto">
            <StatusBadge status={booking.status} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-4 sm:p-5 pt-0">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 sm:gap-4 text-xs sm:text-sm pt-2 border-t border-white/5">
          <div className="flex items-center text-muted-foreground">
            <Calendar className="w-4 h-4 mr-2 text-primary/70 shrink-0" />
            <span className="truncate">{formatLoungeDate(booking.startTime, (booking as any).locationId)}</span>
          </div>
          <div className="flex items-center text-muted-foreground">
            <Clock className="w-4 h-4 mr-2 text-primary/70 shrink-0" />
            <span className="truncate font-mono">
              {formatLoungeTime(booking.startTime, (booking as any).locationId)} - {formatLoungeTime(booking.endTime, (booking as any).locationId)} ({getTimezoneAbbr(booking.startTime, getLoungeTimezone((booking as any).locationId))})
            </span>
          </div>
          <div className="flex items-center justify-between sm:justify-end gap-3">
            <span className="font-bold text-primary font-display text-base">
              ₹{(booking.totalPrice / 100).toFixed(2)}
            </span>
            {onBookAgain && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onBookAgain}
                className="text-xs text-muted-foreground hover:text-primary h-8 px-2.5"
              >
                Book Again
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
