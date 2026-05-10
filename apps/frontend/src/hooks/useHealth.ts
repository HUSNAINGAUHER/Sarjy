import { useQuery } from "@tanstack/react-query";
import type { HealthResponse } from "@sarjy/shared-types";
import { apiClient } from "@/lib/apiClient";

export function useHealth() {
  return useQuery<HealthResponse>({
    queryKey: ["health"],
    queryFn: async () => {
      const { data } = await apiClient.get<HealthResponse>("/health");
      return data;
    },
  });
}
