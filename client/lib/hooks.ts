import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getAlertHealth,
  getBalance,
  dispatchTestAlert,
  requestPayout,
  type TipAlertPayload,
  type UserBalanceSnapshot,
} from "./api";

export function useAlertHealth() {
  return useQuery({
    queryKey: ["alertHealth"],
    queryFn: getAlertHealth,
    refetchInterval: 30_000,
  });
}

export function useBalance(userId: string | null) {
  return useQuery({
    queryKey: ["balance", userId],
    queryFn: () => getBalance(userId!),
    enabled: !!userId,
    retry: false,
  });
}

export function useDispatchAlert() {
  return useMutation({ mutationFn: dispatchTestAlert });
}

export function useRequestPayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: requestPayout,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["balance"] }),
  });
}
