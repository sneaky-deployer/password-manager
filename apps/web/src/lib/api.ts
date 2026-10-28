import { type HealthResponse, healthResponseSchema } from "@pm/shared";

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`Health check failed with status ${res.status}`);
  return healthResponseSchema.parse(await res.json());
}
