// Claude 式更新弹窗:标题 + 自当前版本以来的分版本更新内容 + 稍后/主按钮。
// 更新内容从 GitHub Releases API 拉取(公开仓库免认证);失败时回退展示最新版说明。
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { UpdaterState } from "@/hooks/use-updater";

export interface UpdaterApi {
  state: UpdaterState;
  runCheck: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  relaunchToUpdate: () => Promise<void>;
}

interface ChangelogSection {
  header: string;
  items: string[];
}

interface ChangelogEntry {
  version: string;
  sections: ChangelogSection[];
  raw: string;
}

/** 解析发布说明:### 分节标题 + - 列表项;未识别行并入当前节 */
function parseBody(body: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let cur: ChangelogSection | null = null;
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("###")) {
      cur = { header: t.replace(/^#+\s*/, ""), items: [] };
      sections.push(cur);
    } else if (/^[-*]\s+/.test(t)) {
      if (!cur) {
        cur = { header: "更新内容", items: [] };
        sections.push(cur);
      }
      cur.items.push(t.replace(/^[-*]\s+/, ""));
    } else if (cur) {
      cur.items.push(t);
    }
  }
  return sections;
}

/** x.y.z 升序比较:返回 <0 表示 a 更旧,>0 表示 a 更新,0 为相等(仅数字段) */
function cmpVer(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function fetchChangelog(current: string): Promise<ChangelogEntry[]> {
  const res = await fetch(
    "https://api.github.com/repos/ashu1800/llm-desktop/releases?per_page=30",
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const list = (await res.json()) as Array<{
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    body?: string;
  }>;
  return list
    // 只展示比当前版本新的更新日志;按新→旧排序
    .filter((r) => !r.draft && !r.prerelease && cmpVer(r.tag_name, current) > 0)
    .sort((a, b) => cmpVer(b.tag_name, a.tag_name))
    .map((r) => {
      const raw = r.body ?? "";
      return {
        version: r.tag_name.replace(/^v/, ""),
        raw,
        sections: parseBody(raw),
      };
    });
}

function EntryBlock({ entry }: { entry: ChangelogEntry }) {
  return (
    <div className="border-b border-border/60 pb-4 last:border-0 last:pb-0">
      <div className="font-semibold">v{entry.version}</div>
      {entry.sections.length > 0 ? (
        entry.sections.map((sec) => (
          <div key={sec.header} className="mt-2">
            <div className="text-xs font-semibold text-muted-foreground">
              {sec.header}
            </div>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-relaxed">
              {sec.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        ))
      ) : (
        <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
          {entry.raw}
        </p>
      )}
    </div>
  );
}

export function UpdateDialog({
  open,
  onOpenChange,
  updater,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  updater: UpdaterApi;
}) {
  const { state } = updater;
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    // currentVersion 未就绪(getVersion 未 resolve)时以 "" 比对会把全部 release
    // 误判为"更新":等版本就绪再拉取
    if (!open || !state.currentVersion) return;
    setEntries(null);
    setLoadError(false);
    fetchChangelog(state.currentVersion)
      .then(setEntries)
      .catch(() => setLoadError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, state.currentVersion]);

  const pct =
    state.total && state.total > 0
      ? Math.min(100, Math.round((state.downloaded / state.total) * 100))
      : null;

  const primaryAction = () => {
    switch (state.phase) {
      case "ready":
        return updater.relaunchToUpdate();
      case "downloading":
        return;
      case "error":
        return state.pendingUpdate ? updater.downloadAndInstall() : updater.runCheck();
      default:
        return updater.downloadAndInstall();
    }
  };

  const primaryLabel =
    state.phase === "ready"
      ? "重启以更新"
      : state.phase === "downloading"
        ? pct != null
          ? `下载中 ${pct}%`
          : `下载中 ${(state.downloaded / 1024 / 1024).toFixed(1)} MB`
        : state.phase === "error"
          ? state.pendingUpdate
            ? "重试下载"
            : "重试检查"
          : "立即更新";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader className="gap-3 pb-3 border-b border-border/60">
          <div className="flex items-center gap-3">
            <BrandLogo className="h-10 w-10 shrink-0 drop-shadow-xs" />
            <div>
              <DialogTitle className="flex items-center gap-2 text-base font-bold tracking-tight">
                <span>发现新版本</span>
                <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 font-mono text-xs font-semibold text-primary">
                  v{state.currentVersion ?? "0.0.0"} → v{state.nextVersion ?? "?"}
                </span>
              </DialogTitle>
              <p className="mt-0.5 text-xs text-muted-foreground">
                获取最新功能、协议兼容性修复与稳定性改进
              </p>
            </div>
          </div>
        </DialogHeader>

        {state.phase === "downloading" && (
          <div className="space-y-1.5 py-1">
            <div className="flex justify-between text-xs font-medium">
              <span className="text-muted-foreground">正在下载并校验签名…</span>
              <span className="font-mono text-primary font-semibold">{pct != null ? `${pct}%` : ""}</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted/80 p-0.5">
              <div
                className="h-full rounded-full bg-gradient-to-r from-primary via-orange-400 to-primary transition-all duration-300 shadow-xs"
                style={{ width: `${pct ?? 100}%` }}
              />
            </div>
          </div>
        )}

        <div className="max-h-[50vh] space-y-4 overflow-y-auto pr-1">
          {entries === null && !loadError ? (
            <div className="flex h-36 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 获取更新说明…
            </div>
          ) : entries !== null && entries.length > 0 ? (
            entries.map((e) => <EntryBlock key={e.version} entry={e} />)
          ) : (
            // GitHub API 失败或无分版本条目:回退展示最新版说明
            <div className="rounded-xl border border-border/70 bg-muted/20 p-4">
              <div className="font-semibold text-sm">v{state.nextVersion ?? ""}</div>
              <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground font-mono">
                {state.notes ?? "暂无更新说明。"}
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="items-center gap-2 pt-2 border-t border-border/40">
          {state.phase === "downloading" && (
            <span className="mr-auto text-xs text-muted-foreground">
              安装完成后将提示重启应用生效
            </span>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            稍后
          </Button>
          <Button onClick={primaryAction} disabled={state.phase === "downloading"}>
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
