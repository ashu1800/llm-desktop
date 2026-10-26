import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  Coins,
  Copy,
  KeyRound,
  LayoutDashboard,
  Moon,
  Play,
  RefreshCw,
  Search,
  Square,
  Sun,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import {
  useApiKeys,
  useChannels,
  usePrices,
  useServiceStatus,
  useSettings,
} from "@/hooks/use-gateway";
import { useAppStore } from "@/stores/app-store";
import type { PageKey } from "@/lib/types";
import { cn } from "@/lib/utils";

interface CommandItem {
  id: string;
  category: "导航" | "动作" | "渠道" | "密钥" | "定价";
  title: string;
  subtitle?: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (page: PageKey) => void;
  onOpenUpdate?: () => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  onNavigate,
  onOpenUpdate,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const { data: status } = useServiceStatus();
  const { data: settings } = useSettings();
  const { data: channels } = useChannels();
  const { data: keys } = useApiKeys();
  const { data: prices } = usePrices();

  const resolvedTheme = useAppStore((s) => s.resolvedTheme);

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

  // 打开时自动聚焦并清空输入
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const items = useMemo<CommandItem[]>(() => {
    const list: CommandItem[] = [];

    // 核心动作
    list.push({
      id: "action-service",
      category: "动作",
      title: status?.running ? "停止网关代理服务" : "启动网关代理服务",
      subtitle: status?.running
        ? `当前监听: ${status.addr ?? "8787"}`
        : "在配置的端口启动 HTTP/SSE 代理服务",
      icon: status?.running ? Square : Play,
      badge: status?.running ? "运行中" : "已停止",
      action: async () => {
        try {
          if (status?.running) {
            await api.stopService();
            toast.success("代理服务已停止");
          } else {
            await api.startService();
            toast.success("代理服务已启动");
          }
        } catch (e) {
          toast.error(String(e));
        }
      },
    });

    list.push({
      id: "action-theme",
      category: "动作",
      title: resolvedTheme === "dark" ? "切换为浅色主题" : "切换为深色主题",
      subtitle: "即时切换全软件昼夜视觉外观",
      icon: resolvedTheme === "dark" ? Sun : Moon,
      action: () => toggleTheme(),
    });

    list.push({
      id: "action-copy-base",
      category: "动作",
      title: "复制客户端接入 BaseURL",
      subtitle: `http://${settings?.listenAddr ?? "127.0.0.1"}:${settings?.port ?? 8787}/v1`,
      icon: Copy,
      badge: "BaseURL",
      action: async () => {
        const url = `http://${settings?.listenAddr ?? "127.0.0.1"}:${settings?.port ?? 8787}/v1`;
        await navigator.clipboard.writeText(url);
        toast.success(`BaseURL 已复制: ${url}`);
      },
    });

    if (onOpenUpdate) {
      list.push({
        id: "action-check-update",
        category: "动作",
        title: "检查软件版本更新",
        subtitle: "查询 GitHub Releases 最新版本与更新说明",
        icon: RefreshCw,
        action: () => onOpenUpdate(),
      });
    }

    // 页面导航
    const navs: Array<{ key: PageKey; title: string; num: string }> = [
      { key: "dashboard", title: "打开数据总览", num: "Ctrl+1" },
      { key: "channels", title: "打开渠道管理", num: "Ctrl+2" },
      { key: "keys", title: "打开密钥管理", num: "Ctrl+3" },
      { key: "pricing", title: "打开模型定价", num: "Ctrl+4" },
      { key: "settings", title: "打开应用设置", num: "Ctrl+5" },
    ];
    navs.forEach((n) => {
      list.push({
        id: `nav-${n.key}`,
        category: "导航",
        title: n.title,
        subtitle: `跳转至 ${n.title.replace("打开", "")} 界面`,
        icon: LayoutDashboard,
        badge: n.num,
        action: () => onNavigate(n.key),
      });
    });

    // 渠道直达
    (channels ?? []).forEach((c) => {
      list.push({
        id: `channel-${c.id}`,
        category: "渠道",
        title: c.name,
        subtitle: `${c.protocol} · ${c.baseUrl}`,
        icon: Zap,
        badge: c.enabled ? "已启用" : "已停用",
        action: () => onNavigate("channels"),
      });
    });

    // 密钥直达
    (keys ?? []).forEach((k) => {
      list.push({
        id: `key-${k.id}`,
        category: "密钥",
        title: k.name,
        subtitle: k.remark ? `备注: ${k.remark}` : "可用渠道与模型绑定",
        icon: KeyRound,
        badge: k.enabled ? "有效" : "禁用",
        action: () => onNavigate("keys"),
      });
    });

    // 定价规则
    (prices ?? []).forEach((p) => {
      list.push({
        id: `price-${p.pattern}`,
        category: "定价",
        title: p.pattern,
        subtitle: `输入: ¥${p.input}/M · 输出: ¥${p.output}/M`,
        icon: Coins,
        badge: p.inputUsd != null ? "USD" : "CNY",
        action: () => onNavigate("pricing"),
      });
    });

    return list;
  }, [
    status,
    settings,
    channels,
    keys,
    prices,
    resolvedTheme,
    toggleTheme,
    onNavigate,
    onOpenUpdate,
  ]);

  // 模糊匹配过滤
  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.trim().toLowerCase();
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.category.includes(q) ||
        (item.subtitle && item.subtitle.toLowerCase().includes(q)),
    );
  }, [items, query]);

  // 键盘快捷键监听: 上下箭头移动选择，Enter 执行，Esc 关闭
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % Math.max(1, filtered.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev === 0 ? Math.max(0, filtered.length - 1) : prev - 1,
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          filtered[selectedIndex].action();
          onOpenChange(false);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, filtered, selectedIndex, onOpenChange]);

  // 选中项越界安全收敛
  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(0);
    }
  }, [filtered.length, selectedIndex]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-20">
          {/* 毛玻璃蒙层 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => onOpenChange(false)}
            className="fixed inset-0 bg-black/40 backdrop-blur-xs"
          />

          {/* 指令浮岛面板 */}
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -8 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="relative z-10 flex w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border/80 bg-background/95 shadow-2xl backdrop-blur-md"
          >
            {/* 顶部搜索框 */}
            <div className="flex items-center border-b border-border/60 px-4 py-3">
              <Search className="mr-3 h-4 w-4 shrink-0 text-muted-foreground/70" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelectedIndex(0);
                }}
                placeholder="键入指令、动作或搜索渠道、密钥、模型规则… (Esc 退出)"
                className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
              <kbd className="hidden rounded border border-border/60 bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-block">
                ESC
              </kbd>
            </div>

            {/* 结果列表 */}
            <div className="max-h-[380px] overflow-y-auto p-2">
              {filtered.length === 0 ? (
                <div className="py-12 text-center text-xs text-muted-foreground">
                  未找到匹配「{query}」的指令或数据
                </div>
              ) : (
                <div className="space-y-1">
                  {filtered.map((item, idx) => {
                    const isSelected = idx === selectedIndex;
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          item.action();
                          onOpenChange(false);
                        }}
                        onMouseEnter={() => setSelectedIndex(idx)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors select-none",
                          isSelected
                            ? "bg-accent text-accent-foreground shadow-2xs"
                            : "text-muted-foreground hover:bg-muted/40",
                        )}
                      >
                        <div
                          className={cn(
                            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors shadow-2xs",
                            isSelected
                              ? "border-primary/40 bg-primary/10 text-primary"
                              : "border-border/70 bg-muted/50 text-muted-foreground",
                          )}
                        >
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                "text-xs font-semibold tracking-tight",
                                isSelected ? "text-foreground" : "text-foreground/90",
                              )}
                            >
                              {item.title}
                            </span>
                            <span className="rounded-md border border-border/50 bg-muted/50 px-1.5 py-0.5 font-sans text-[10px] text-muted-foreground">
                              {item.category}
                            </span>
                          </div>
                          {item.subtitle && (
                            <p className="truncate font-mono text-[11px] text-muted-foreground/80 mt-0.5">
                              {item.subtitle}
                            </p>
                          )}
                        </div>
                        {item.badge && (
                          <span className="rounded border border-border/60 bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                            {item.badge}
                          </span>
                        )}
                        {isSelected && (
                          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-primary" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 底部快捷键提示 */}
            <div className="flex items-center justify-between border-t border-border/50 bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <kbd className="rounded border border-border/70 bg-background px-1">↑</kbd>
                  <kbd className="rounded border border-border/70 bg-background px-1">↓</kbd>
                  移动
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="rounded border border-border/70 bg-background px-1.5">↵</kbd>
                  执行
                </span>
              </div>
              <span className="text-[10px] opacity-80">
                按 <kbd className="rounded border border-border/70 bg-background px-1">Ctrl+K</kbd> 随时唤起
              </span>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}