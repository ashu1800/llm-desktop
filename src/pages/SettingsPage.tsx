import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { AlertTriangle, Check, Download, Minimize2, Power, Save, ShieldCheck, Trash2, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { useSettings } from "@/hooks/use-gateway";
import { useUpdater } from "@/hooks/use-updater";
import { BrandLogo } from "@/components/BrandLogo";
import { ClientMappingSettings } from "@/components/ClientMappingSettings";
import { ProxySettings } from "@/components/ProxySettings";
import type { AppSettings, ImportPreview, ThemeMode } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
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
  value,
  onChange,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  // 暂存原始输入串:受控 number 输入下 Number("") === 0 会把"清空"变成写入 0
  // (端口 0 → 后端静默回 8787;保留天数 0 → 清日志风险),中间态 "0." 也被折叠
  const [raw, setRaw] = useState<string | null>(null);
  const display = raw ?? (Number.isFinite(value) ? String(value) : "");
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          value={display}
          onChange={(e) => {
            setRaw(e.target.value);
            const n = Number(e.target.value);
            // 合法数值才写回 form;清空/非法保持旧值,保存时由后端钳制
            if (e.target.value !== "" && Number.isFinite(n)) onChange(n);
          }}
          onBlur={() => setRaw(null)} // 失焦回到显示 form 实际值
          className="w-28"
        />
        {suffix && (
          <span className="text-xs text-muted-foreground">{suffix}</span>
        )}
      </div>
    </div>
  );
}

function ToggleField({
  label,
  description,
  icon: Icon,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border/70 bg-background/50 px-3.5 py-3 shadow-2xs transition-all hover:bg-background">
      <div className="flex items-center gap-3">
        {Icon && (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-muted/60 text-muted-foreground shadow-2xs">
            <Icon className="h-4 w-4" />
          </div>
        )}
        <div className="space-y-0.5">
          <Label className="cursor-pointer text-sm font-medium text-foreground">{label}</Label>
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

// ---------- 设置页 ----------

/** 设置分类:分夹切换展示 */
const SETTING_TABS = [
  { key: "gateway", label: "服务与网关" },
  { key: "app", label: "应用" },
  { key: "proxy", label: "代理管理" },
  { key: "client", label: "客户端映射" },
  { key: "data", label: "日志与数据" },
  { key: "about", label: "关于" },
] as const;

type SettingTab = (typeof SETTING_TABS)[number]["key"];

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
  const [tab, setTab] = useState<SettingTab>("gateway");
  // dirty 基准 = 本地表单快照,而非服务端实时值:
  // settings 会被外部修改(顶栏主题/导入配置/settingsChanged),若直接与
  // settings 比较,外部变更会被误报为"未保存修改",点保存会回滚它们
  const [baseSnapshot, setBaseSnapshot] = useState<string | null>(null);

  useEffect(() => {
    // settings 重取且表单无本地修改时跟随刷新;有修改则保留用户输入
    if (settings && !dirty) {
      setForm(structuredClone(settings));
      setBaseSnapshot(JSON.stringify(settings));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

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

  const dirty = !!form && baseSnapshot !== JSON.stringify(form);

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
      setBaseSnapshot(JSON.stringify(updated));
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
    <div className="mx-auto max-w-3xl pb-16">
      {/* 分类选择夹: 物理弹簧滑动分段控制器 */}
      <div className="relative mb-5 flex items-center gap-1 rounded-xl border border-border/80 bg-muted/50 p-1 shadow-2xs">
        {SETTING_TABS.map((t) => {
          const isActive = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "relative flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors select-none",
                isActive
                  ? "text-foreground font-semibold"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {isActive && (
                <motion.span
                  layoutId="active-settings-tab"
                  className="absolute inset-0 rounded-lg bg-background shadow-xs ring-1 ring-border/80"
                  transition={{ type: "spring", stiffness: 450, damping: 35 }}
                />
              )}
              <span className="relative z-10">{t.label}</span>
            </button>
          );
        })}
      </div>

      <div className="space-y-6">
        {tab === "gateway" && (
          <>
            <SectionCard title="服务监听">
              <div className="grid gap-4 sm:grid-cols-2">
                <NumberField
                  label="端口"
                  value={form.port}
                  onChange={(v) => patch({ port: v })}
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

            <SectionCard title="熔断全局默认参数">
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
                />
                <NumberField
                  label="退避上限"
                  value={form.breaker.backoffMaxSecs}
                  onChange={(v) => patchBreaker({ backoffMaxSecs: v })}
                  suffix="秒"
                />
              </div>
            </SectionCard>

            <SectionCard title="超时默认值">
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
          </>
        )}

        {tab === "app" && (
          <>
            <SectionCard title="系统集成">
              <div className="space-y-2.5">
                <ToggleField
                  label="开机自启"
                  description="系统登录后自动在后台拉起网关服务，无需每次手动启动"
                  icon={Power}
                  checked={form.autostart}
                  onChange={(v) => patch({ autostart: v })}
                />
                <ToggleField
                  label="启动时最小化到托盘"
                  description="启动时直接隐入系统托盘运行，不主动弹出前台主界面"
                  icon={Minimize2}
                  checked={form.silentStart}
                  onChange={(v) => patch({ silentStart: v })}
                />
                <ToggleField
                  label="关闭窗口时隐藏到托盘"
                  description="点击窗口右上角关闭按钮时保持后台常驻，而不是退出程序"
                  icon={ShieldCheck}
                  checked={form.closeToTray}
                  onChange={(v) => patch({ closeToTray: v })}
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
          </>
        )}

        {tab === "proxy" && (
          <SectionCard title="代理管理">
            <ProxySettings form={form} patch={patch} />
          </SectionCard>
        )}

        {tab === "client" && (
          <SectionCard title="客户端映射">
            <ClientMappingSettings form={form} patch={patch} />
          </SectionCard>
        )}

        {tab === "data" && (
          <div className="space-y-6">
            <SectionCard title="日志存储">
              <div className="grid gap-4 sm:grid-cols-2">
                <NumberField
                  label="日志保留天数"
                  value={form.logRetentionDays}
                  onChange={(v) => patch({ logRetentionDays: v })}
                  suffix="天"
                />
                <div className="space-y-1.5">
                  <Label>完整报文保存</Label>
                  <ToggleField
                    label="保存请求/响应快照"
                    description="记录上游请求体与响应体完整 JSON"
                    checked={form.saveFullBody}
                    onChange={(v) => patch({ saveFullBody: v })}
                  />
                </div>
              </div>
            </SectionCard>

            <SectionCard title="数据备份与迁移">
              <p className="mb-3 text-xs text-muted-foreground">
                将当前网关的所有渠道、密钥与全局设置导出为便携 JSON 文件，或从已有备份中导入。
              </p>
              <div className="flex flex-wrap gap-2.5">
                <Button
                  variant="outline"
                  disabled={exportMut.isPending}
                  onClick={() => exportMut.mutate()}
                  className="gap-1.5 shadow-2xs"
                >
                  <Download className="h-4 w-4" /> 导出完整配置
                </Button>
                <Button
                  variant="outline"
                  disabled={importPreviewMut.isPending || importApplyMut.isPending}
                  onClick={() => importPreviewMut.mutate()}
                  className="gap-1.5 shadow-2xs"
                >
                  <Upload className="h-4 w-4" /> 导入配置
                </Button>
              </div>
            </SectionCard>

            {/* 危险区域 (Danger Zone) */}
            <Card className="border border-destructive/35 bg-gradient-to-r from-destructive/10 via-destructive/5 to-transparent shadow-xs">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base text-destructive">
                  <AlertTriangle className="h-4 w-4" />
                  危险区域
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                  <div>
                    <h5 className="text-sm font-semibold text-foreground">清空全部请求日志</h5>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      将永久抹除本地 SQLite 数据库中的所有请求记录与快照，该操作不可撤销。
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={clearLogsMut.isPending}
                    onClick={() => setClearLogsOpen(true)}
                    className="shrink-0 gap-1.5 shadow-xs"
                  >
                    <Trash2 className="h-4 w-4" /> 清空日志
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {tab === "about" && (
          <div className="space-y-6">
            {/* 官方品牌展台 (Hero Card) */}
            <Card className="overflow-hidden border border-border/80 bg-gradient-to-b from-card via-card to-muted/20 shadow-sm">
              <div className="flex flex-col items-center p-8 text-center">
                <div className="relative mb-3.5 flex items-center justify-center">
                  <div className="absolute inset-0 -m-3 rounded-3xl bg-primary/10 blur-xl dark:bg-primary/20" />
                  <BrandLogo className="relative h-16 w-16 drop-shadow-md" />
                </div>
                <h2 className="text-xl font-bold tracking-tight text-foreground">
                  LLM Gateway
                </h2>
                <p className="mt-1 max-w-md text-xs text-muted-foreground">
                  基于 Tauri 2 + Rust 的本地大模型 API 网关 · 三协议四入口与高可用中继
                </p>

                {/* 核心技术架构徽标 */}
                <div className="mt-5 flex flex-wrap items-center justify-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <span className="rounded-full border border-border bg-background px-2.5 py-0.5 shadow-2xs">
                    Tauri 2
                  </span>
                  <span className="rounded-full border border-border bg-background px-2.5 py-0.5 shadow-2xs">
                    Rust Core
                  </span>
                  <span className="rounded-full border border-border bg-background px-2.5 py-0.5 shadow-2xs">
                    Axum Multi-Protocol
                  </span>
                  <span className="rounded-full border border-border bg-background px-2.5 py-0.5 shadow-2xs">
                    SQLite WAL
                  </span>
                  <span className="rounded-full border border-border bg-background px-2.5 py-0.5 shadow-2xs">
                    React 18 + Tailwind
                  </span>
                </div>
              </div>
            </Card>

            <SectionCard title="软件更新">
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
                      <span className="ml-3 text-destructive">{update.error}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {update.phase === "ready" ? (
                      <Button size="sm" onClick={relaunchToUpdate}>
                        重启应用完成更新
                      </Button>
                    ) : update.phase === "available" ||
                      (update.phase === "error" && update.pendingUpdate) ? (
                      <Button size="sm" onClick={downloadAndInstall}>
                        {update.phase === "error" ? "重试下载" : "下载并安装"}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={update.phase === "checking"}
                        onClick={checkForUpdate}
                      >
                        {update.phase === "checking"
                          ? "检查中…"
                          : update.phase === "error"
                            ? "重新检查"
                            : "检查更新"}
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
          </div>
        )}
      </div>

      {/* 底部保存条:所有分类共用,修改不丢失 */}
      <div className="sticky bottom-0 -mx-6 mt-6 flex items-center justify-between border-t bg-background/95 px-6 py-3 backdrop-blur shadow-sm">
        {dirty ? (
          <div className="flex items-center gap-2 text-xs font-medium text-amber-600 dark:text-amber-400">
            <span className="relative flex h-2 w-2">
              <span className="absolute h-full w-full animate-ping rounded-full bg-amber-500 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
            </span>
            <span>当前包含未保存的配置更改</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check className="h-3.5 w-3.5 text-success" />
            <span>所有修改已安全落盘生效</span>
          </div>
        )}
        <Button
          onClick={save}
          disabled={!dirty || saving}
          className={cn(
            "transition-all duration-200",
            dirty && "shadow-xs ring-2 ring-primary/20",
          )}
        >
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
