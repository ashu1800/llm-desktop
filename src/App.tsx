import { useEffect, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { useGatewayEvents, useThemeEffect } from "@/hooks/use-gateway";
import { useUpdater } from "@/hooks/use-updater";
import { useAppStore } from "@/stores/app-store";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { DashboardPage } from "@/pages/DashboardPage";
import { LogsPage } from "@/pages/LogsPage";
import { ChannelsPage } from "@/pages/ChannelsPage";
import { KeysPage } from "@/pages/KeysPage";
import { PricingPage } from "@/pages/PricingPage";
import { SettingsPage } from "@/pages/SettingsPage";
import type { PageKey } from "@/lib/types";

export default function App() {
  const [page, setPage] = useState<PageKey>("dashboard");
  useGatewayEvents();
  useThemeEffect();
  const resolvedTheme = useAppStore((s) => s.resolvedTheme);

  // 启动静默检查更新(6h 节流);发现新版本时 toast 提醒,安装入口在设置页
  const { state: updateState } = useUpdater({ auto: true });
  const updateNotified = useRef(false);
  useEffect(() => {
    if (updateState.phase === "available" && !updateNotified.current) {
      updateNotified.current = true;
      toast.info(`发现新版本 v${updateState.nextVersion}`, {
        description: "前往「设置 → 软件更新」下载安装",
      });
    }
  }, [updateState.phase, updateState.nextVersion]);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar page={page} onNavigate={setPage} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar page={page} />
        <main className="flex-1 overflow-auto bg-muted/30 p-6">
          {page === "dashboard" && <DashboardPage />}
          {page === "logs" && <LogsPage />}
          {page === "channels" && <ChannelsPage />}
          {page === "keys" && <KeysPage />}
          {page === "pricing" && <PricingPage />}
          {page === "settings" && <SettingsPage />}
        </main>
      </div>
      <Toaster position="top-center" richColors theme={resolvedTheme} />
    </div>
  );
}
