"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl } from "@/shared/routes";
import type { InsertBooking } from "@/shared/schema";
import { useToast } from "@/hooks/use-toast";

export function useBookings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: bookings, isLoading } = useQuery({
    queryKey: [api.bookings.list.path],
    queryFn: async () => {
      const res = await fetch(api.bookings.list.path, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch bookings");
      return await res.json();
    },
  });

  const createBooking = useMutation({
    mutationFn: async (data: InsertBooking) => {
      const res = await fetch(api.bookings.create.path, {
        method: api.bookings.create.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Booking failed" }));
        throw new Error(err.message || "Failed to create booking");
      }
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.bookings.list.path] });
      toast({ title: "⚡ Booking Confirmed!", description: "See you at Play N' Slay." });
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
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to update status");
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.bookings.list.path] });
      toast({ title: "Status Updated" });
    },
  });

  const startTimer = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/bookings/${id}/timer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to start timer");
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.bookings.list.path] });
      toast({ title: "Session Timer Started" });
    },
  });

  const stopTimer = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/bookings/${id}/timer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to stop timer");
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.bookings.list.path] });
      toast({ title: "Session Completed" });
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
