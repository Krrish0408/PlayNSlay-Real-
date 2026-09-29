"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl } from "@/shared/routes";
import type { InsertGameType } from "@/shared/schema";
import { useToast } from "@/hooks/use-toast";

export function useGameTypes() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: gameTypes, isLoading } = useQuery({
    queryKey: [api.gameTypes.list.path],
    queryFn: async () => {
      const res = await fetch(api.gameTypes.list.path, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch game types");
      return await res.json();
    },
  });

  const createGameType = useMutation({
    mutationFn: async (data: InsertGameType) => {
      const res = await fetch(api.gameTypes.create.path, {
        method: api.gameTypes.create.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({ message: "Failed to create station" }));
        throw new Error(error.message || "Failed to create game type");
      }
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.gameTypes.list.path] });
      toast({ title: "Success", description: "Gaming station created" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateGameType = useMutation({
    mutationFn: async ({ id, ...updates }: { id: number } & Partial<InsertGameType>) => {
      const url = buildUrl(api.gameTypes.update.path, { id });
      const res = await fetch(url, {
        method: api.gameTypes.update.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to update game type");
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.gameTypes.list.path] });
      toast({ title: "Success", description: "Gaming station updated" });
    },
  });

  const deleteGameType = useMutation({
    mutationFn: async (id: number) => {
      const url = buildUrl(api.gameTypes.delete.path, { id });
      const res = await fetch(url, { method: api.gameTypes.delete.method, credentials: "include" });
      if (!res.ok) throw new Error("Failed to delete game type");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.gameTypes.list.path] });
      toast({ title: "Success", description: "Gaming station deleted" });
    },
  });

  return {
    gameTypes,
    isLoading,
    createGameType,
    updateGameType,
    deleteGameType,
  };
}
