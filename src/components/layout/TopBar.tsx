// 自绘标题栏(Tauri decorations:false):单栏融合应用名、页面标题、服务操作与窗口控制。
// 参考 CC Switch 布局:左侧应用标识 + 中部页面标题 + 右侧主操作与 最小化/最大化/关闭。
// 拖拽移动经 data-tauri-drag-region;窗口控制走 @tauri-apps/api/window。
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, Copy, Loader2, Minus, Moon, Play, Square, Sun, X } from "lucide-react";
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
  channels: "渠道管理",
  keys: "密钥管理",
  pricing: "模型定价",
  settings: "应用设置",
};

function formatUptime(seconds: number): string {
  if (seconds < 60) return "刚刚启动";
  const m = Math.floor(seconds / 60);
  if (m < 60) return `已运行 ${m}分钟`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return `已运行 ${h}小时${remM > 0 ? `${remM}分` : ""}`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return `已运行 ${d}天${remH > 0 ? `${remH}时` : ""}`;
}

const appWindow = getCurrentWindow();

export function TopBar({ page }: TopBarProps) {
  const { data: status } = useServiceStatus();
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const resolvedTheme = useAppStore((s) => s.resolvedTheme);
  const [maximized, setMaximized] = useState(false);
  const [copiedHost, setCopiedHost] = useState(false);
  const [uptimeText, setUptimeText] = useState("刚刚启动");
  // 计时起点用 ref 存放:放进 effect 依赖会在"停止"分支造成 set→依赖变→重跑的死循环渲染
  const startedAtRef = useRef<number>(Date.now());

  // 服务运行状态与持续时间计时器
  useEffect(() => {
    if (status?.running) {
      // 每次从停止转为运行时重置起点;运行中依赖不变,effect 不会重跑
      startedAtRef.current = Date.now();
      const update = () =>
        setUptimeText(
          formatUptime(Math.floor((Date.now() - startedAtRef.current) / 1000)),
        );
      update();
      const timer = setInterval(update, 10000);
      return () => clearInterval(timer);
    }
    // 服务停止或尚未就绪:固定文案。同值 setState 会被 React bail out,无渲染风暴
    setUptimeText("刚刚启动");
  }, [status?.running]);

  // 最大化状态跟踪:切换图标(还原/最大化)与提示
  useEffect(() => {
    let disposed = false;
    const sync = () => {
      if (!disposed) appWindow.isMaximized().then(setMaximized).catch(() => {});
    };
    sync();
    const un = appWindow.onResized(sync);
    return () => {
      disposed = true;
      un.then((f) => f()).catch(() => {});
    };
  }, []);

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
    <header
      data-tauri-drag-region
      className="flex h-14 shrink-0 select-none items-center gap-3 border-b bg-muted/60 pl-4 pr-0 backdrop-blur-sm"
    >
      {/* 页面面包屑与标题: 简约现代, 留白透气 */}
      <div data-tauri-drag-region className="flex items-center gap-2">
        <span data-tauri-drag-region className="text-xs text-muted-foreground/60">
          控制台
        </span>
        <span data-tauri-drag-region className="text-xs text-muted-foreground/30">
          /
        </span>
        <h1
          data-tauri-drag-region
          className="text-sm font-semibold tracking-tight text-foreground"
        >
          {PAGE_TITLES[page]}
        </h1>
      </div>

      <div data-tauri-drag-region className="flex-1" />

      {/* 服务状态: 快捷复制服务地址微岛 */}
      <button
        onClick={async () => {
          const addr =
            status?.running && status.addr
              ? `http://${status.addr}`
              : `http://${settings?.listenAddr ?? "127.0.0.1"}:${settings?.port ?? 8787}`;
          try {
            await navigator.clipboard.writeText(addr);
            setCopiedHost(true);
            toast.success(`网关地址已复制: ${addr}`);
            setTimeout(() => setCopiedHost(false), 1500);
          } catch {
            toast.error("复制失败");
          }
        }}
        className="group/host flex items-center gap-2 rounded-full border border-border/80 bg-background/80 px-3 py-1 text-xs shadow-2xs backdrop-blur-sm transition-all hover:border-primary/40 hover:bg-background active:scale-95"
        title="点击一键复制网关服务地址"
      >
        <span
          className={cn(
            "h-2 w-2 rounded-full transition-all duration-300",
            status?.running ? "status-dot-running" : "status-dot-stopped"
          )}
        />
        <span className="font-mono text-xs tabular-nums text-foreground/90">
          {status?.running
            ? (status.addr ?? "运行中")
            : `已停止 · ${settings?.listenAddr ?? "127.0.0.1"}:${settings?.port ?? 8787}`}
        </span>
        {status?.running && (
          <span className="border-l border-border/60 pl-2 font-sans text-[11px] text-muted-foreground/80">
            {uptimeText}
          </span>
        )}
        {copiedHost ? (
          <Check className="h-3 w-3 shrink-0 text-success" />
        ) : (
          <Copy className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/host:opacity-70" />
        )}
      </button>

      <Button
        variant={status?.running ? "outline" : "default"}
        size="sm"
        disabled={toggleMutation.isPending}
        onClick={() => toggleMutation.mutate()}
        className={cn(
          "gap-1.5 transition-all",
          status?.running
            ? "hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
            : "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90"
        )}
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

      <Button
        variant="ghost"
        size="icon"
        onClick={toggleTheme}
        title="切换主题"
        className="relative text-muted-foreground transition-all duration-200 hover:text-foreground active:scale-90"
      >
        <Sun className="h-4 w-4 rotate-0 scale-100 transition-all duration-300 dark:-rotate-90 dark:scale-0" />
        <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all duration-300 dark:rotate-0 dark:scale-100" />
      </Button>

      {/* 窗口控制:细分割线隔开,关闭键悬停红(Windows 惯例) */}
      <div className="ml-1 flex h-full items-stretch border-l">
        <button
          title="最小化"
          className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => appWindow.minimize()}
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          title={maximized ? "还原" : "最大化"}
          className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => appWindow.toggleMaximize()}
        >
          {maximized ? (
            // 还原:双矩形
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1.5" y="3.5" width="9" height="9" rx="1" stroke="currentColor" />
              <path
                d="M4 3.5V2.5C4 1.94772 4.44772 1.5 5 1.5H11.5C12.0523 1.5 12.5 1.94772 12.5 2.5V9C12.5 9.55228 12.0523 10 11.5 10H10.5"
                stroke="currentColor"
              />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1.5" y="1.5" width="11" height="11" rx="1" stroke="currentColor" />
            </svg>
          )}
        </button>
        <button
          title="关闭"
          className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-white"
          onClick={() => appWindow.close()}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

interface TopBarProps {
  page: PageKey;
}
