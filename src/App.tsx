import { useState } from "react";
import { Toaster } from "sonner";
import { useGatewayEvents, useThemeEffect } from "@/hooks/use-gateway";
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
