import { create } from "zustand";
import type { ThemeMode } from "@/lib/types";

// UI 级状态(zustand);服务端状态归 TanStack Query
interface AppStore {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  /** 由 settings.theme + 系统偏好解析出的实际主题 */
  resolvedTheme: "light" | "dark";
  setResolvedTheme: (t: "light" | "dark") => void;
  /** 请求日志实时同步开关:关闭时忽略后端 requestLogged 事件 */
  logsLive: boolean;
  setLogsLive: (v: boolean) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  resolvedTheme: "light",
  setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),
  logsLive: true,
  setLogsLive: (logsLive) => set({ logsLive }),
}));

export function themeLabel(mode: ThemeMode): string {
  return mode === "system" ? "跟随系统" : mode === "dark" ? "深色" : "浅色";
}
