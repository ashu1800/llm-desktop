import {
  ArrowUp,
  Cable,
  Coins,
  KeyRound,
  LayoutDashboard,
  Settings,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
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
    <aside className="flex w-56 shrink-0 flex-col border-r bg-muted">
      <div className="flex h-14 items-center gap-2.5 border-b px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Waypoints className="h-4 w-4" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">LLM Gateway</div>
          <div className="text-[11px] text-muted-foreground">本地 API 网关</div>
        </div>
      </div>
      <nav className="flex-1 space-y-1 p-3">
        {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => onNavigate(key)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
              page === key
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground"
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="flex-1 text-left">{label}</span>
          </button>
        ))}
      </nav>
      <div className="flex items-center justify-between border-t p-3 text-[11px] text-muted-foreground">
        <span>{version ? `v${version}` : ""}</span>
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
