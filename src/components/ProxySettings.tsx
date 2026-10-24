// 代理管理:命名代理池的增删改 + 连通性测延迟 + 更新器代理选择。
// 代理池存 settings.proxies;渠道编辑里按 url 引用(下拉选择),更新器按名引用。
// 支持 socks5:// 与 http(s):// 两类;由后端 reqwest 实际拨测,此处只展示结果。
import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { AppSettings, ProxyEntry } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type LatencyState = { status: "idle" | "testing" | "ok" | "fail"; ms?: number; error?: string };

function ProxyRow({
  entry,
  index,
  form,
  patch,
}: {
  entry: ProxyEntry;
  index: number;
  form: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
}) {
  const [latency, setLatency] = useState<LatencyState>({ status: "idle" });

  const setName = (name: string) => {
    const proxies = [...form.proxies];
    // 名字被更新器引用时同步改名,保持引用有效
    const oldName = entry.name;
    proxies[index] = { ...entry, name };
    const updaterProxy =
      form.updaterProxy === oldName ? name : form.updaterProxy;
    patch({ proxies, updaterProxy });
  };
  const setUrl = (url: string) => {
    const proxies = [...form.proxies];
    proxies[index] = { ...entry, url };
    patch({ proxies });
  };
  const remove = () => {
    patch({
      proxies: form.proxies.filter((_, i) => i !== index),
      // 删除被更新器引用的代理 → 直连
      updaterProxy: form.updaterProxy === entry.name ? "" : form.updaterProxy,
    });
  };

  const test = async () => {
    if (!entry.url.trim()) {
      toast.error("请先填写代理地址");
      return;
    }
    setLatency({ status: "testing" });
    try {
      const ms = await api.testProxyLatency(entry.url.trim());
      setLatency({ status: "ok", ms });
    } catch (e) {
      setLatency({ status: "fail", error: String(e) });
    }
  };

  return (
    <div className="space-y-1.5 rounded-lg border bg-muted/30 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Input
          value={entry.name}
          onChange={(e) => setName(e.target.value)}
          placeholder="名称,如:家里 clash"
          className="h-8 w-36 shrink-0 text-sm"
          maxLength={30}
        />
        <Input
          value={entry.url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="socks5://127.0.0.1:7890 或 http://127.0.0.1:7890"
          className="h-8 flex-1 font-mono text-xs"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1 px-2 text-xs"
          disabled={latency.status === "testing"}
          onClick={test}
        >
          {latency.status === "testing" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : null}
          测延迟
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
          title="删除此代理"
          onClick={remove}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {latency.status === "ok" && (
        <p className="text-xs text-emerald-600 dark:text-emerald-400">
          连接正常 · 延迟 {latency.ms}ms
        </p>
      )}
      {latency.status === "fail" && (
        <p className="text-xs text-destructive">{latency.error}</p>
      )}
    </div>
  );
}

export function ProxySettings({
  form,
  patch,
}: {
  form: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
}) {
  const proxies = form.proxies ?? [];

  const addProxy = () => {
    patch({
      proxies: [...proxies, { name: "", url: "socks5://127.0.0.1:7890" }],
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>代理列表</Label>
          <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={addProxy}>
            <Plus className="h-3 w-3" /> 添加代理
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          支持 socks5:// 与 http(s):// 代理;渠道编辑中可引用,用于上游请求走代理。
          修改后需点击页面底部"保存"生效。
        </p>
        {proxies.length === 0 ? (
          <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
            尚未配置代理;上游渠道与 GitHub 更新可直连使用
          </p>
        ) : (
          <div className="space-y-2">
            {proxies.map((p, i) => (
              <ProxyRow key={i} entry={p} index={i} form={form} patch={patch} />
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label>GitHub 更新代理</Label>
        <Select
          value={form.updaterProxy || ""}
          onValueChange={(v) => patch({ updaterProxy: v === "__direct" ? "" : v })}
        >
          <SelectTrigger className="w-64">
            <SelectValue placeholder="直连" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__direct">直连(不走代理)</SelectItem>
            {proxies
              .filter((p) => p.name.trim())
              .map((p) => (
                <SelectItem key={p.name} value={p.name}>
                  {p.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          检查更新与下载更新包都经此代理;网络无法直达 GitHub 时选择代理。
        </p>
      </div>
    </div>
  );
}
