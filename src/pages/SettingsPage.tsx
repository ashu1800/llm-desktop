import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Save } from "lucide-react";
import { api } from "@/lib/api";
import { useSettings } from "@/hooks/use-gateway";
import { useUpdater } from "@/hooks/use-updater";
import type { AppSettings, ImportPreview, ThemeMode } from "@/lib/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ---------- 通用字段控件 ----------

function NumberField({
  label,
  desc,
  value,
  onChange,
  suffix,
}: {
  label: string;
  desc?: string;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-28"
        />
        {suffix && (
          <span className="text-xs text-muted-foreground">{suffix}</span>
        )}
      </div>
      {desc && <p className="text-xs text-muted-foreground">{desc}</p>}
    </div>
  );
}

function ToggleField({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <div className="space-y-1">
        <Label>{label}</Label>
        {desc && <p className="text-xs text-muted-foreground">{desc}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

// ---------- 设置页 ----------

export function SettingsPage() {
  const { data: settings, isLoading } = useSettings();
  const qc = useQueryClient();
  const [form, setForm] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmLanOpen, setConfirmLanOpen] = useState(false);
  const [importTarget, setImportTarget] = useState<{
    path: string;
    preview: ImportPreview;
  } | null>(null);
  const [clearLogsOpen, setClearLogsOpen] = useState(false);

  const exportMut = useMutation({
    mutationFn: api.exportConfig,
    onSuccess: (p) =>
      p ? toast.success(`配置已导出到 ${p}`) : toast.info("已取消导出"),
    onError: (e) => toast.error(String(e)),
  });
  const importPreviewMut = useMutation({
    mutationFn: api.importConfigPreview,
    onSuccess: (r) => {
      if (!r) {
        toast.info("已取消导入");
        return;
      }
      setImportTarget({ path: r[0], preview: r[1] });
    },
    onError: (e) => toast.error(String(e)),
  });
  const importApplyMut = useMutation({
    mutationFn: (path: string) => api.importConfigApply(path),
    onSuccess: () => {
      setImportTarget(null);
      qc.invalidateQueries();
      toast.success("导入完成,已热生效");
    },
    onError: (e) => toast.error(String(e)),
  });
  const clearLogsMut = useMutation({
    mutationFn: api.clearLogs,
    onSuccess: () => {
      setClearLogsOpen(false);
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      toast.success("日志已清空");
    },
    onError: (e) => toast.error(String(e)),
  });

  const {
    state: update,
    runCheck: checkForUpdate,
    downloadAndInstall,
    relaunchToUpdate,
  } = useUpdater();

  useEffect(() => {
    if (settings && !form) setForm(structuredClone(settings));
  }, [settings, form]);

  const dirty =
    !!form && !!settings && JSON.stringify(form) !== JSON.stringify(settings);

  const patch = (p: Partial<AppSettings>) =>
    setForm((f) => (f ? { ...f, ...p } : f));
  const patchBreaker = (p: Partial<AppSettings["breaker"]>) =>
    setForm((f) => (f ? { ...f, breaker: { ...f.breaker, ...p } } : f));
  const patchTimeouts = (p: Partial<AppSettings["timeouts"]>) =>
    setForm((f) => (f ? { ...f, timeouts: { ...f.timeouts, ...p } } : f));

  const doSave = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const updated = await api.updateSettings(form);
      setForm(structuredClone(updated));
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success("设置已保存并生效");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!form) return;
    // 切换 0.0.0.0 需二次确认(密钥暴露给局域网 + Windows 防火墙授权)
    if (
      form.listenAddr === "0.0.0.0" &&
      settings &&
      settings.listenAddr !== "0.0.0.0"
    ) {
      setConfirmLanOpen(true);
      return;
    }
    await doSave();
  };

  if (isLoading || !form || !settings) {
    return (
      <div className="py-20 text-center text-sm text-muted-foreground">
        加载设置中…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-16">
      <SectionCard
        title="服务监听"
        description="数据面 axum 服务配置;修改端口保存后立即热重启监听,无需重启应用。"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="端口"
            value={form.port}
            onChange={(v) => patch({ port: v })}
            desc="保存前自动检测占用,冲突将拒绝保存"
          />
          <div className="space-y-1.5">
            <Label>监听地址</Label>
            <Select
              value={form.listenAddr}
              onValueChange={(v) => patch({ listenAddr: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="127.0.0.1">127.0.0.1(仅本机)</SelectItem>
                <SelectItem value="0.0.0.0">0.0.0.0(局域网可访问)</SelectItem>
              </SelectContent>
            </Select>
            {form.listenAddr === "0.0.0.0" && (
              <p className="flex items-start gap-1.5 text-xs text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                密钥将暴露给局域网,保存时需二次确认;Windows
                首次监听会弹出防火墙授权,请选择"允许"。
              </p>
            )}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="系统集成">
        <ToggleField
          label="开机自启"
          desc="写入注册表 Run 项,启动参数附带 --silent(强制静默进托盘)"
          checked={form.autostart}
          onChange={(v) => patch({ autostart: v })}
        />
        <ToggleField
          label="启动时最小化到托盘"
          desc="启动不弹窗口,仅托盘运行"
          checked={form.silentStart}
          onChange={(v) => patch({ silentStart: v })}
        />
        <ToggleField
          label="关闭窗口时隐藏到托盘"
          desc="关闭 = 隐藏并保持代理运行;关闭后代理服务继续转发请求。关闭此开关则点关闭按钮直接退出程序"
          checked={form.closeToTray}
          onChange={(v) => patch({ closeToTray: v })}
        />
      </SectionCard>

      <SectionCard title="日志">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="日志保留天数"
            value={form.logRetentionDays}
            onChange={(v) => patch({ logRetentionDays: v })}
            suffix="天"
            desc="每日凌晨自动清理过期日志"
          />
          <div className="space-y-1.5">
            <Label>完整报文保存</Label>
            <ToggleField
              label="保存完整请求/响应体"
              desc="默认各截断 32KB;开启后完整保存(占用更多磁盘)"
              checked={form.saveFullBody}
              onChange={(v) => patch({ saveFullBody: v })}
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="熔断全局默认参数"
        description="渠道可单独覆盖;滑动窗口内连续失败达到阈值,或样本足够且失败率超阈值时熔断打开。"
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField
            label="滑动窗口"
            value={form.breaker.windowSecs}
            onChange={(v) => patchBreaker({ windowSecs: v })}
            suffix="秒"
          />
          <NumberField
            label="连续失败阈值"
            value={form.breaker.consecutiveFailures}
            onChange={(v) => patchBreaker({ consecutiveFailures: v })}
            suffix="次"
          />
          <NumberField
            label="最小样本数"
            value={form.breaker.sampleMin}
            onChange={(v) => patchBreaker({ sampleMin: v })}
            suffix="条"
          />
          <NumberField
            label="失败率阈值"
            value={Math.round(form.breaker.failureRate * 100)}
            onChange={(v) => patchBreaker({ failureRate: v / 100 })}
            suffix="%"
          />
          <NumberField
            label="冷却期"
            value={form.breaker.cooldownSecs}
            onChange={(v) => patchBreaker({ cooldownSecs: v })}
            suffix="秒"
            desc="连续熔断按 60→120→240 指数退避"
          />
          <NumberField
            label="退避上限"
            value={form.breaker.backoffMaxSecs}
            onChange={(v) => patchBreaker({ backoffMaxSecs: v })}
            suffix="秒"
          />
        </div>
      </SectionCard>

      <SectionCard
        title="超时默认值"
        description="流式请求不设总时长硬顶,仅用空闲超时判定死亡;慢渠道请在渠道级调大首字超时。"
      >
        <div className="grid gap-4 sm:grid-cols-4">
          <NumberField
            label="连接"
            value={form.timeouts.connectSecs}
            onChange={(v) => patchTimeouts({ connectSecs: v })}
            suffix="秒"
          />
          <NumberField
            label="首字 TTFT"
            value={form.timeouts.ttftSecs}
            onChange={(v) => patchTimeouts({ ttftSecs: v })}
            suffix="秒"
          />
          <NumberField
            label="流式空闲"
            value={form.timeouts.streamIdleSecs}
            onChange={(v) => patchTimeouts({ streamIdleSecs: v })}
            suffix="秒"
          />
          <NumberField
            label="非流式总时长"
            value={form.timeouts.nonStreamTotalSecs}
            onChange={(v) => patchTimeouts({ nonStreamTotalSecs: v })}
            suffix="秒"
          />
        </div>
      </SectionCard>

      <SectionCard title="外观">
        <div className="max-w-xs space-y-1.5">
          <Label>主题</Label>
          <Select
            value={form.theme}
            onValueChange={(v) => patch({ theme: v as ThemeMode })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">跟随系统</SelectItem>
              <SelectItem value="light">浅色</SelectItem>
              <SelectItem value="dark">深色</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </SectionCard>

      <SectionCard
        title="软件更新"
        description="检查 GitHub Releases 上的新版本;下载后经 minisign 签名校验安装,重启即完成更新。"
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm">
              <span className="text-muted-foreground">当前版本 </span>
              <span className="font-mono">{update.currentVersion ?? "—"}</span>
              {update.phase === "available" && (
                <span className="ml-3 text-success">
                  发现新版本 v{update.nextVersion}
                </span>
              )}
              {update.phase === "uptodate" && (
                <span className="ml-3 text-muted-foreground">已是最新版本</span>
              )}
              {update.phase === "error" && (
                <span className="ml-3 text-destructive">
                  检查失败:{update.error}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {update.phase === "ready" ? (
                <Button size="sm" onClick={relaunchToUpdate}>
                  重启应用完成更新
                </Button>
              ) : update.phase === "available" ? (
                <Button size="sm" onClick={downloadAndInstall}>
                  下载并安装
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={update.phase === "checking"}
                  onClick={checkForUpdate}
                >
                  {update.phase === "checking" ? "检查中…" : "检查更新"}
                </Button>
              )}
            </div>
          </div>
          {update.phase === "downloading" && (
            <div className="space-y-1.5">
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{
                    width:
                      update.total && update.total > 0
                        ? `${Math.min(100, (update.downloaded / update.total) * 100)}%`
                        : "100%",
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {update.total
                  ? `${(update.downloaded / 1024 / 1024).toFixed(1)} / ${(update.total / 1024 / 1024).toFixed(1)} MB`
                  : `${(update.downloaded / 1024 / 1024).toFixed(1)} MB`}
              </p>
            </div>
          )}
          {update.notes && update.phase !== "idle" && (
            <pre className="max-h-32 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
              {update.notes}
            </pre>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="配置导入 / 导出与日志"
        description="导出 JSON(渠道 + 密钥 + 定价 + 设置,含明文密钥,请妥善保管;日志不导出)。导入为整表替换并立即热生效。"
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={exportMut.isPending}
            onClick={() => exportMut.mutate()}
          >
            导出配置
          </Button>
          <Button
            variant="outline"
            disabled={importPreviewMut.isPending || importApplyMut.isPending}
            onClick={() => importPreviewMut.mutate()}
          >
            导入配置
          </Button>
          <Button
            variant="destructive"
            disabled={clearLogsMut.isPending}
            onClick={() => setClearLogsOpen(true)}
          >
            清空日志
          </Button>
        </div>
      </SectionCard>

      {/* 底部保存条 */}
      <div className="sticky bottom-0 -mx-6 flex items-center justify-between border-t bg-background/95 px-6 py-3 backdrop-blur">
        <span className="text-xs text-muted-foreground">
          {dirty ? "有未保存的修改" : "所有修改已保存"}
        </span>
        <Button onClick={save} disabled={!dirty || saving}>
          {saving ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          保存设置
        </Button>
      </div>

      {/* 0.0.0.0 二次确认 */}
      <Dialog open={confirmLanOpen} onOpenChange={setConfirmLanOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认监听 0.0.0.0?</DialogTitle>
            <DialogDescription>
              局域网内任何设备都能用你的自建密钥访问本网关并消耗上游额度。
              Windows 首次监听 0.0.0.0 时系统会弹出防火墙授权,请选择"允许"。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmLanOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                setConfirmLanOpen(false);
                doSave();
              }}
            >
              确认并保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 导入二次确认 */}
      <Dialog
        open={importTarget != null}
        onOpenChange={(o) => !o && setImportTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认导入配置?</DialogTitle>
            <DialogDescription>
              将覆盖当前全部渠道({importTarget?.preview.channels ?? 0} 个)、密钥(
              {importTarget?.preview.keys ?? 0} 个)、定价(
              {importTarget?.preview.prices ?? 0} 条)与设置,并立即热生效。请求日志不受影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportTarget(null)}>
              取消
            </Button>
            <Button
              disabled={importApplyMut.isPending}
              onClick={() => importTarget && importApplyMut.mutate(importTarget.path)}
            >
              确认导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 清空日志二次确认 */}
      <Dialog open={clearLogsOpen} onOpenChange={setClearLogsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清空全部请求日志?</DialogTitle>
            <DialogDescription>
              将删除所有历史请求记录与统计依据,费用汇总随之归零;该操作不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearLogsOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={clearLogsMut.isPending}
              onClick={() => clearLogsMut.mutate()}
            >
              确认清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
