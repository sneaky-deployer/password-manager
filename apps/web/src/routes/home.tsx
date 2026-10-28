import { useQuery } from "@tanstack/react-query";
import { fetchHealth } from "../lib/api.ts";

export function Home() {
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth });

  return (
    <>
      <h1 className="text-3xl font-semibold">Password Manager</h1>
      <p className="mt-4" role="status">
        {health.isPending && "API status: checking..."}
        {health.isError && "API status: unreachable"}
        {health.isSuccess && "API status: ok"}
      </p>
    </>
  );
}
