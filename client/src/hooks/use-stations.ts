import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl } from "@shared/routes";
import type { InsertStation, Station, StationStatus } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";

export function useStations() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: stations, isLoading } = useQuery({
    queryKey: [api.stations.list.path],
    queryFn: async () => {
      const res = await fetch(api.stations.list.path);
      if (!res.ok) throw new Error("Failed to fetch stations");
      const parsed = api.stations.list.responses[200].parse(await res.json());
      return Array.isArray(parsed) ? parsed : parsed.items;
    },
  });

  const createStation = useMutation({
    mutationFn: async (data: InsertStation) => {
      const res = await fetch(api.stations.create.path, {
        method: api.stations.create.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.message || "Failed to create station");
      }
      return api.stations.create.responses[201].parse(await res.json());
    },
    onSuccess: (station) => {
      queryClient.invalidateQueries({ queryKey: [api.stations.list.path] });
      toast({ title: "Station Added", description: `Station ${station.name} created successfully.` });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateStation = useMutation({
    mutationFn: async ({ id, ...updates }: { id: number } & Partial<InsertStation>) => {
      const url = buildUrl(api.stations.update.path, { id });
      const res = await fetch(url, {
        method: api.stations.update.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error("Failed to update station");
      return api.stations.update.responses[200].parse(await res.json());
    },
    onSuccess: (station) => {
      queryClient.invalidateQueries({ queryKey: [api.stations.list.path] });
      toast({ title: "Station Updated", description: `${station.name} status: ${station.status}` });
    },
    onError: (err: Error) => {
      toast({ title: "Update Failed", description: err.message, variant: "destructive" });
    },
  });

  const updateStationStatus = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: StationStatus }) => {
      const url = buildUrl(api.stations.update.path, { id });
      const res = await fetch(url, {
        method: api.stations.update.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Failed to update station status");
      return api.stations.update.responses[200].parse(await res.json());
    },
    onSuccess: (station) => {
      queryClient.invalidateQueries({ queryKey: [api.stations.list.path] });
      toast({ title: "Status Updated", description: `${station.name} is now ${station.status}.` });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteStation = useMutation({
    mutationFn: async (id: number) => {
      const url = buildUrl(api.stations.delete.path, { id });
      const res = await fetch(url, { method: api.stations.delete.method });
      if (!res.ok) throw new Error("Failed to delete station");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.stations.list.path] });
      toast({ title: "Station Deleted", description: "Station removed from lounge." });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return {
    stations,
    isLoading,
    createStation,
    updateStation,
    updateStationStatus,
    deleteStation,
  };
}
