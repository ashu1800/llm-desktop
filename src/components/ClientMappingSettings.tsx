// 客户端映射管理:控制请求日志"客户端"列的显示名与图标。
// 条目来自历史日志中实际出现过的客户端(list_clients 去重查询);
// 别名/图标存入设置 clientAliases / clientIcons,前端展示层动态套用,
// 修改保存后历史日志立即生效(落库值不被改写)。
import { useQuery } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { api } from "@/lib/api";
import type { AppSettings } from "@/lib/types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function ClientRow({
  name,
  form,
  patch,
}: {
  name: string;
  form: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
}) {
  const alias = form.clientAliases[name] ?? "";
  const icon = form.clientIcons[name] ?? "";
  const setAlias = (v: string) =>
    patch({
      clientAliases: { ...form.clientAliases, [name]: v },
    });
  const setIcon = (v: string) =>
    patch({
      clientIcons: { ...form.clientIcons, [name]: v },
    });
  const displayName = alias || name;

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
      {/* 图标预览与输入:emoji 直接渲染,未设置时显示通用机器人图标 */}
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-card text-lg leading-none">
        {icon ? (
          <span>{icon}</span>
        ) : (
          <Bot className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
      <Input
        value={icon}
        onChange={(e) => setIcon(e.target.value)}
        placeholder="图标"
        className="h-8 w-16 shrink-0 text-center text-base"
        maxLength={4}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-muted-foreground" title={name}>
          {name}
        </div>
        {alias && (
          <div className="truncate text-sm font-medium">
            {displayName}
          </div>
        )}
      </div>
      <div className="shrink-0">
        <Label className="sr-only">显示名称</Label>
        <Input
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          placeholder={name}
          className="h-8 w-40 text-sm"
          maxLength={40}
        />
      </div>
    </div>
  );
}

export function ClientMappingSettings({
  form,
  patch,
}: {
  form: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
}) {
  const { data: clients } = useQuery({
    queryKey: ["clients"],
    queryFn: api.listClients,
  });

  const list = clients ?? [];
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        控制请求日志"客户端"列的显示:左侧输入 emoji 图标,右侧自定义显示名称;
        留空保持默认。修改对所有历史与后续日志立即生效。
      </p>
      {list.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          暂无请求记录,客户端首次出现后会出现在这里
        </p>
      ) : (
        <div className="space-y-2">
          {list.map((c) => (
            <ClientRow key={c} name={c} form={form} patch={patch} />
          ))}
        </div>
      )}
    </div>
  );
}
