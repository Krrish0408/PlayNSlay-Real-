import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";
import type { InsertBooking } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";

export function useBookings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: bookings, isLoading } = useQuery({
    queryKey: [api.bookings.list.path],
    queryFn: async () => {
      const res = await fetch(api.bookings.list.path);
      if (!res.ok) throw new Error("Failed to fetch bookings");
      const parsed = api.bookings.list.responses[200].parse(await res.json());
      return Array.isArray(parsed) ? parsed : parsed.items;
    },
  });

  const createBooking = useMutation({
    mutationFn: async (data: InsertBooking) => {
      const res = await fetch(api.bookings.create.path, {
        method: api.bookings.create.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || err.message || "Failed to create booking");
      }
      return api.bookings.create.responses[201].parse(await res.json());
    },
    onSuccess: (booking: any) => {
      queryClient.invalidateQueries({ queryKey: [api.bookings.list.path] });
      toast({
        title: "Booking Confirmed! 🎮",
        description: booking.station?.name
          ? `Reserved at ${booking.station.name} (${booking.gameType?.name || 'Session'})`
          : "See you at the lounge.",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Booking Failed", description: err.message, variant: "destructive" });
    },
  });

  const updateBookingStatus = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: "Pending" | "Approved" | "Cancelled" | "Completed" }) => {
      const url = buildUrl(api.bookings.updateStatus.path, { id });
      const res = await fetch(url, {
        method: api.bookings.updateStatus.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Failed to update status");
      return api.bookings.updateStatus.responses[200].parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.bookings.list.path] });
      toast({ title: "Status Updated" });
    },
  });

  const startTimer = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/bookings/${id}/timer/start`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to start timer");
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.bookings.list.path] });
      toast({ title: "Timer Started" });
    },
  });

  const stopTimer = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/bookings/${id}/timer/stop`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to stop timer");
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.bookings.list.path] });
      toast({ title: "Timer Stopped" });
    },
  });

  return {
    bookings,
    isLoading,
    createBooking,
    updateBookingStatus,
    startTimer,
    stopTimer,
  };
}
