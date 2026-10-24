// Claude 式更新弹窗:标题 + 自当前版本以来的分版本更新内容 + 稍后/主按钮。
// 更新内容从 GitHub Releases API 拉取(公开仓库免认证);失败时回退展示最新版说明。
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
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
        <DialogHeader>
          <DialogTitle className="flex items-baseline gap-2.5">
            <span>更新到 v{state.nextVersion ?? "?"}</span>
            <span className="text-xs font-normal text-muted-foreground">
              自 v{state.currentVersion ?? "?"} 以来的更新内容
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-[55vh] space-y-5 overflow-y-auto pr-1">
          {entries === null && !loadError ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 获取更新内容…
            </div>
          ) : entries !== null && entries.length > 0 ? (
            entries.map((e) => <EntryBlock key={e.version} entry={e} />)
          ) : (
            // GitHub API 失败或无分版本条目:回退展示最新版说明
            <div>
              <div className="font-semibold">v{state.nextVersion ?? ""}</div>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                {state.notes ?? "暂无更新说明。"}
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="items-center gap-2">
          {state.phase === "downloading" && (
            <span className="mr-auto text-xs text-muted-foreground">
              正在校验签名并安装,完成后请重启
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
