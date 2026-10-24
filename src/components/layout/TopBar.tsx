import { Loader2, Moon, Play, Square, Sun } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useServiceStatus, useSettings } from "@/hooks/use-gateway";
import { useAppStore } from "@/stores/app-store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PageKey } from "@/lib/types";

const PAGE_TITLES: Record<PageKey, string> = {
  dashboard: "数据总览",
  logs: "请求日志",
  channels: "渠道管理",
  keys: "密钥管理",
  pricing: "模型定价",
  settings: "应用设置",
};

interface TopBarProps {
  page: PageKey;
}

export function TopBar({ page }: TopBarProps) {
  const { data: status } = useServiceStatus();
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const resolvedTheme = useAppStore((s) => s.resolvedTheme);

  const toggleMutation = useMutation({
    mutationFn: () =>
      status?.running ? api.stopService() : api.startService(),
    onSuccess: (s) => {
      qc.setQueryData(["service"], s);
      toast.success(s.running ? "代理服务已启动" : "代理服务已停止");
    },
    onError: (e) => toast.error(String(e)),
  });

  const toggleTheme = async () => {
    if (!settings) return;
    const next =
      settings.theme === "dark"
        ? "light"
        : settings.theme === "light"
          ? "dark"
          : resolvedTheme === "dark"
            ? "light"
            : "dark";
    try {
      await api.updateSettings({ ...settings, theme: next });
      qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4">
      <h1 className="text-sm font-semibold">{PAGE_TITLES[page]}</h1>
      <div className="flex-1" />
      {/* 服务状态:绿=运行、灰=停止 */}
      <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            status?.running ? "bg-success" : "bg-muted-foreground/40"
          )}
        />
        <span className="font-mono">
          {status?.running
            ? (status.addr ?? "运行中")
            : `已停止 · ${settings?.listenAddr ?? "127.0.0.1"}:${settings?.port ?? 8787}`}
        </span>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={toggleMutation.isPending}
        onClick={() => toggleMutation.mutate()}
      >
        {toggleMutation.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : status?.running ? (
          <Square className="h-3.5 w-3.5" />
        ) : (
          <Play className="h-3.5 w-3.5" />
        )}
        {status?.running ? "停止服务" : "启动服务"}
      </Button>
      <Button variant="ghost" size="icon" onClick={toggleTheme} title="切换主题">
        {resolvedTheme === "dark" ? (
          <Sun className="h-4 w-4" />
        ) : (
          <Moon className="h-4 w-4" />
        )}
      </Button>
    </header>
  );
}
