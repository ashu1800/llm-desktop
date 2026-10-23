import { create } from "zustand";
import type { ThemeMode } from "@/lib/types";

// UI 级状态(zustand);服务端状态归 TanStack Query
interface AppStore {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  /** 由 settings.theme + 系统偏好解析出的实际主题 */
  resolvedTheme: "light" | "dark";
  setResolvedTheme: (t: "light" | "dark") => void;
}

export const useAppStore = create<AppStore>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  resolvedTheme: "light",
  setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),
}));

export function themeLabel(mode: ThemeMode): string {
  return mode === "system" ? "跟随系统" : mode === "dark" ? "深色" : "浅色";
}
