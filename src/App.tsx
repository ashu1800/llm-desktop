import { useEffect, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { AnimatePresence, motion } from "framer-motion";
import { useGatewayEvents, useThemeEffect } from "@/hooks/use-gateway";
import { useUpdater } from "@/hooks/use-updater";
import { useAppStore } from "@/stores/app-store";
import { cn } from "@/lib/utils";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { UpdateDialog } from "@/components/UpdateDialog";
import { DashboardPage } from "@/pages/DashboardPage";
import { ChannelsPage } from "@/pages/ChannelsPage";
import { KeysPage } from "@/pages/KeysPage";
import { PricingPage } from "@/pages/PricingPage";
import { SettingsPage } from "@/pages/SettingsPage";
import type { PageKey } from "@/lib/types";

export default function App() {
  const [page, setPage] = useState<PageKey>("dashboard");
  const [updateOpen, setUpdateOpen] = useState(false);
  useGatewayEvents();
  useThemeEffect();
  const resolvedTheme = useAppStore((s) => s.resolvedTheme);

  // 启动检查更新;发现新版本时 toast 提醒,侧栏出现"更新"入口,点开是更新弹窗
  const updater = useUpdater({ auto: true });
  const { state: updateState } = updater;
  const updateNotified = useRef(false);
  useEffect(() => {
    if (updateState.phase === "available" && !updateNotified.current) {
      updateNotified.current = true;
      toast.info(`发现新版本 v${updateState.nextVersion}`, {
        description: "点击侧栏「更新」查看更新内容并安装",
      });
    }
  }, [updateState.phase, updateState.nextVersion]);

  // 全局数字快捷键: Ctrl/Cmd + 1~5 切换页面
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        const keyMap: Record<string, PageKey> = {
          "1": "dashboard",
          "2": "channels",
          "3": "keys",
          "4": "pricing",
          "5": "settings",
        };
        const targetPage = keyMap[e.key];
        if (targetPage) {
          e.preventDefault();
          setPage(targetPage);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 有待装更新(已发现/下载中/待重启/下载失败可重试)时显示入口
  const updatePending =
    ["available", "downloading", "ready"].includes(updateState.phase) ||
    (updateState.phase === "error" && updateState.pendingUpdate);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        page={page}
        onNavigate={setPage}
        updateAvailable={updatePending}
        onOpenUpdate={() => setUpdateOpen(true)}
        version={updateState.currentVersion}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar page={page} />
        {/* dashboard 日志表需内滚贴合视口(overflow-hidden + h-full);
            其余页面内容超长需页面级滚动(overflow-auto),按页面切换 */}
        <main
          className={cn(
            "flex-1 bg-muted/30 p-6",
            page === "dashboard" ? "overflow-hidden" : "overflow-auto",
          )}
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={page}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
              className="h-full"
            >
              {page === "dashboard" && <DashboardPage />}
              {page === "channels" && <ChannelsPage />}
              {page === "keys" && <KeysPage />}
              {page === "pricing" && <PricingPage />}
              {page === "settings" && <SettingsPage />}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <UpdateDialog
        open={updateOpen}
        onOpenChange={setUpdateOpen}
        updater={updater}
      />
      <Toaster position="top-center" richColors theme={resolvedTheme} />
    </div>
  );
}
