import { useQuery } from "@tanstack/react-query";
import { type LoungeLocation, DEFAULT_LOCATION_ID, getLocation } from "@shared/timezone";

export function useLoungeConfig(locationId: string = DEFAULT_LOCATION_ID) {
  return useQuery<LoungeLocation & { allLocations: LoungeLocation[] }>({
    queryKey: ["/api/lounge/config", locationId],
    queryFn: async () => {
      try {
        const res = await fetch(`/api/lounge/config?locationId=${encodeURIComponent(locationId)}`);
        if (!res.ok) {
          const loc = getLocation(locationId);
          return { ...loc, allLocations: [loc] };
        }
        return await res.json();
      } catch {
        const loc = getLocation(locationId);
        return { ...loc, allLocations: [loc] };
      }
    },
    staleTime: 1000 * 60 * 30, // 30 minutes
    initialData: {
      ...getLocation(locationId),
      allLocations: [getLocation(locationId)],
    },
  });
}
