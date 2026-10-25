import {
  ArrowUp,
  Cable,
  Coins,
  Github,
  KeyRound,
  LayoutDashboard,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BrandLogo } from "@/components/BrandLogo";
import { cn } from "@/lib/utils";
import type { PageKey } from "@/lib/types";

interface NavItem {
  key: PageKey;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { key: "dashboard", label: "数据总览", icon: LayoutDashboard },
  { key: "channels", label: "渠道管理", icon: Cable },
  { key: "keys", label: "密钥管理", icon: KeyRound },
  { key: "pricing", label: "模型定价", icon: Coins },
  { key: "settings", label: "应用设置", icon: Settings },
];

interface SidebarProps {
  page: PageKey;
  onNavigate: (page: PageKey) => void;
  /** 检测到新版本时在版本号旁显示"更新"入口 */
  updateAvailable?: boolean;
  /** 点击"更新"打开更新弹窗 */
  onOpenUpdate?: () => void;
  /** 当前应用版本(getVersion 异步获取) */
  version?: string | null;
}

export function Sidebar({
  page,
  onNavigate,
  updateAvailable,
  onOpenUpdate,
  version,
}: SidebarProps) {
  return (
    <aside className="flex w-[168px] shrink-0 flex-col border-r bg-muted/90 backdrop-blur-sm">
      {/* 品牌区: 嵌入 Gateway G 品牌专属微标与主副标题 */}
      <div className="flex h-14 items-center gap-2.5 border-b px-3.5">
        <BrandLogo className="h-7 w-7 drop-shadow-xs" />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-xs font-semibold tracking-tight text-foreground">
            LLM Gateway
          </div>
          <div className="text-[10px] text-muted-foreground/80">本地 API 网关</div>
        </div>
      </div>
      <nav className="flex-1 space-y-1 p-2.5">
        {NAV_ITEMS.map(({ key, label, icon: Icon }, idx) => (
          <button
            key={key}
            onClick={() => onNavigate(key)}
            className={cn(
              "group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-all duration-150 active:scale-[0.98]",
              page === key
                ? "bg-accent/90 font-medium text-foreground shadow-xs"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
            title={`快捷键: Ctrl+${idx + 1}`}
          >
            {/* 激活状态左侧陶土橘垂直指示胶囊 */}
            {page === key && (
              <span className="absolute left-0.5 h-4 w-1 rounded-full bg-primary" />
            )}
            <Icon
              className={cn(
                "h-4 w-4 shrink-0 transition-colors",
                page === key
                  ? "text-primary"
                  : "text-muted-foreground group-hover:text-foreground"
              )}
            />
            <span className="flex-1 text-left">{label}</span>
            <kbd className="opacity-0 group-hover:opacity-100 transition-opacity rounded border border-border/60 bg-muted/60 px-1 font-mono text-[10px] text-muted-foreground/80 shadow-2xs">
              {idx + 1}
            </kbd>
          </button>
        ))}
      </nav>
      <div className="flex items-center justify-between border-t p-3 text-xs text-muted-foreground">
        {/* Tauri 下 <a target=_blank> 被拦,必须走 opener 插件用系统浏览器打开 */}
        <button
          title="GitHub 仓库"
          className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
          onClick={() =>
            openUrl("https://github.com/ashu1800/llm-desktop").catch(() => {})
          }
        >
          <Github className="h-3.5 w-3.5" />
          <span className="font-mono text-[11px]">{version ? `v${version}` : ""}</span>
        </button>
        {updateAvailable && (
          <button
            onClick={onOpenUpdate}
            title="查看更新内容并安装"
            className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-medium text-primary transition-colors hover:bg-primary/20"
          >
            <ArrowUp className="h-3 w-3" />
            更新
          </button>
        )}
      </div>
    </aside>
  );
}
