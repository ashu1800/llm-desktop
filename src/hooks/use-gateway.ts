import { useEffect, useRef } from "react";
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

// 日志/统计实时同步:后端批量落库后广播 requestLogged 事件(见 useGatewayEvents),
// 前端失效对应查询立即刷新;不再定时轮询

export function useLogs(filter: LogFilter) {
  return useQuery({
    queryKey: ["logs", filter],
    queryFn: () => api.queryLogs(filter),
  });
}

export function useStats(filter: LogFilter) {
  return useQuery({
    queryKey: ["stats", filter],
    queryFn: () => api.getStats(filter),
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
  // live 经 ref 透传:监听器只注册一次,开关变化不重挂、不丢事件
  const liveRef = useRef(true);
  const prevLiveRef = useRef(true);
  prevLiveRef.current = liveRef.current;
  liveRef.current = useAppStore((s) => s.logsLive);
  // 暂停期间落库的事件已错过:恢复开关时补拉一次,消除"假死"窗口
  useEffect(() => {
    if (liveRef.current && !prevLiveRef.current) {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
    }
  });
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    // requestLogged 防抖 300ms:批量写入每次落库都广播,合并短时间内的多批为一次刷新
    let logDebounce: ReturnType<typeof setTimeout> | undefined;
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
      } else if (event.type === "requestLogged" && liveRef.current) {
        clearTimeout(logDebounce);
        logDebounce = setTimeout(() => {
          // 仅刷新第 1 页(offset=0):浏览历史页时新请求落库不扰动当前视图
          qc.invalidateQueries({
            queryKey: ["logs"],
            predicate: (q) => {
              const f = q.queryKey[1] as LogFilter | undefined;
              return !f || (f.offset ?? 0) === 0;
            },
          });
          qc.invalidateQueries({ queryKey: ["stats"] });
        }, 300);
      }
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      clearTimeout(logDebounce);
      unlisten?.();
    };
  }, [qc]);
}

/** 把 settings.theme 应用到 <html class="dark">,并解析出实际主题;同步客户端映射到 store */
export function useThemeEffect() {
  const { data: settings } = useSettings();
  const setResolvedTheme = useAppStoreSetResolved();
  const setClientMapping = useAppStore((s) => s.setClientMapping);
  useEffect(() => {
    if (settings) {
      setClientMapping(settings.clientAliases ?? {}, settings.clientIcons ?? {});
    }
  }, [settings, setClientMapping]);
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
