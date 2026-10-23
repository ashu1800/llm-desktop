import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { listenGatewayEvents } from "@/lib/events";
import type { LogFilter } from "@/lib/types";

export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
}

export function useChannels() {
  return useQuery({ queryKey: ["channels"], queryFn: api.listChannels });
}

export function useApiKeys() {
  return useQuery({ queryKey: ["keys"], queryFn: api.listApiKeys });
}

export function usePrices() {
  return useQuery({ queryKey: ["prices"], queryFn: api.listModelPrices });
}

export function useUnpricedModels() {
  return useQuery({ queryKey: ["unpriced"], queryFn: api.listUnpricedModels });
}

export function useBreakerStates() {
  // 事件推送为主,5s 轮询兜底(剩余冷却秒数递减也需要刷新)
  return useQuery({
    queryKey: ["breakers"],
    queryFn: api.getBreakerStates,
    refetchInterval: 5000,
  });
}

// ---------- 日志与统计(M7) ----------

export function useLogs(filter: LogFilter, live: boolean) {
  return useQuery({
    queryKey: ["logs", filter],
    queryFn: () => api.queryLogs(filter),
    refetchInterval: live ? 10_000 : false,
  });
}

export function useStats(filter: LogFilter) {
  return useQuery({
    queryKey: ["stats", filter],
    queryFn: () => api.getStats(filter),
    refetchInterval: 10_000,
  });
}

export function useTrend(filter: LogFilter, bucket: "hour" | "day") {
  return useQuery({
    queryKey: ["trend", filter, bucket],
    queryFn: () => api.getTrend(filter, bucket),
  });
}

export function useChannelStats(filter: LogFilter) {
  return useQuery({
    queryKey: ["channelStats", filter],
    queryFn: () => api.getChannelStats(filter),
  });
}

export function useModelStats(filter: LogFilter) {
  return useQuery({
    queryKey: ["modelStats", filter],
    queryFn: () => api.getModelStats(filter),
  });
}

// 事件推送为主、低频轮询兜底,保证状态徽标即时更新
export function useServiceStatus() {
  return useQuery({
    queryKey: ["service"],
    queryFn: api.getServiceStatus,
    refetchInterval: 5000,
  });
}

export function useGatewayEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listenGatewayEvents((event) => {
      if (event.type === "serviceStatus") {
        qc.setQueryData(["service"], {
          running: event.running,
          addr: event.addr,
        });
      } else if (event.type === "settingsChanged") {
        qc.invalidateQueries({ queryKey: ["settings"] });
      } else if (event.type === "breakerChanged") {
        qc.invalidateQueries({ queryKey: ["breakers"] });
      }
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [qc]);
}

/** 把 settings.theme 应用到 <html class="dark">,并解析出实际主题 */
export function useThemeEffect() {
  const { data: settings } = useSettings();
  const setResolvedTheme = useAppStoreSetResolved();
  useEffect(() => {
    const mode = settings?.theme ?? "system";
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = mode === "dark" || (mode === "system" && mq.matches);
      document.documentElement.classList.toggle("dark", dark);
      setResolvedTheme(dark ? "dark" : "light");
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [settings?.theme, setResolvedTheme]);
}

import { useAppStore } from "@/stores/app-store";
function useAppStoreSetResolved() {
  return useAppStore((s) => s.setResolvedTheme);
}
