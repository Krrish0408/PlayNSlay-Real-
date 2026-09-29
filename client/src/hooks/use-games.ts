import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";
import type { InsertGame } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";

export function useGames() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: games, isLoading } = useQuery({
    queryKey: [api.games.list.path],
    queryFn: async () => {
      const res = await fetch(api.games.list.path);
      if (!res.ok) throw new Error("Failed to fetch games");
      const parsed = api.games.list.responses[200].parse(await res.json());
      return Array.isArray(parsed) ? parsed : parsed.items;
    },
  });

  const createGame = useMutation({
    mutationFn: async (data: InsertGame) => {
      const res = await fetch(api.games.create.path, {
        method: api.games.create.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Failed to create game");
      }
      return api.games.create.responses[201].parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.games.list.path] });
      toast({ title: "Success", description: "Game added to catalog" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateGame = useMutation({
    mutationFn: async ({ id, ...updates }: { id: number } & Partial<InsertGame>) => {
      const url = buildUrl(api.games.update.path, { id });
      const res = await fetch(url, {
        method: api.games.update.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error("Failed to update game");
      return api.games.update.responses[200].parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.games.list.path] });
      toast({ title: "Success", description: "Game updated successfully" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteGame = useMutation({
    mutationFn: async (id: number) => {
      const url = buildUrl(api.games.delete.path, { id });
      const res = await fetch(url, { method: api.games.delete.method });
      if (!res.ok) throw new Error("Failed to delete game");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.games.list.path] });
      toast({ title: "Success", description: "Game removed from catalog" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return {
    games,
    isLoading,
    createGame,
    updateGame,
    deleteGame,
  };
}