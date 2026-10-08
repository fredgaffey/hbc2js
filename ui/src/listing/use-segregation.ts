// ui/src/listing/use-segregation.ts — `GET /api/segregation` as a query.
//
// Two exceptions to "immutable", both re-polled rather than treated as
// final:
//
// `refetchInterval` re-polls while either is true and stops (`false`
// return) once both have settled — a real interval, not `staleTime`,
// because a cached-but-stale answer would otherwise never be asked for
// again.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchSegregation, type SegregationPage } from "./wire.ts";

const COMPUTING_POLL_MS = 500;
const DEPS_POLL_MS = 5000;

export const useSegregation = (): UseQueryResult<SegregationPage | null> =>
  useQuery({
    queryKey: ["segregation"],
    queryFn: () => fetchSegregation(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined || data === null) return false;
      if (data.computing === true) return COMPUTING_POLL_MS;
      return data.depsApplied ? false : DEPS_POLL_MS;
    },
  });
