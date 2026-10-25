// 客户端映射管理:控制请求日志"客户端"列的显示名与图标。
// 条目来自历史日志中实际出现过的客户端(list_clients 去重查询);
// 别名/图标存入设置 clientAliases / clientIcons,前端展示层动态套用,
// 修改保存后历史日志立即生效(落库值不被改写)。
// 图标支持两种形态:emoji 直接输入,或"选图片"经后端规范化为 64px PNG dataURL
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bot, ImagePlus, X } from "lucide-react";
import { api } from "@/lib/api";
import type { AppSettings } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** 图标值是否为图片 dataURL(区别于 emoji 文本) */
function isImageDataUrl(v: string): boolean {
  return v.startsWith("data:image/");
}

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
  const [picking, setPicking] = useState(false);
  const setAlias = (v: string) =>
    patch({
      clientAliases: { ...form.clientAliases, [name]: v },
    });
  const setIcon = (v: string) =>
    patch({
      clientIcons: { ...form.clientIcons, [name]: v },
    });
  const displayName = alias || name;

  const pickImage = async () => {
    setPicking(true);
    try {
      const dataUrl = await api.pickClientIcon();
      if (dataUrl) setIcon(dataUrl);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/80 bg-background/50 px-3.5 py-2.5 shadow-2xs transition-all hover:bg-background">
      {/* 图标微展台:emoji 直接渲染,dataURL 渲染 <img>;未设置显示通用机器人 */}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/80 bg-card text-lg leading-none shadow-2xs">
        {icon ? (
          isImageDataUrl(icon) ? (
            <img src={icon} alt="" className="h-full w-full object-contain" />
          ) : (
            <span>{icon}</span>
          )
        ) : (
          <Bot className="h-4 w-4 text-muted-foreground/70" />
        )}
      </div>
      {icon ? (
        // 已设置:显示清除按钮(emoji/图片统一从此处移除)
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-16 shrink-0"
          title="移除图标"
          onClick={() => setIcon("")}
        >
          <X className="h-4 w-4 text-muted-foreground" />
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-16 shrink-0 gap-1 px-2 text-xs"
          title="选择图片文件(支持 png/jpg/gif/webp/bmp/ico/tiff 等常见格式)"
          disabled={picking}
          onClick={pickImage}
        >
          <ImagePlus className="h-3.5 w-3.5" />
          图片
        </Button>
      )}
      <Input
        value={isImageDataUrl(icon) ? "" : icon}
        onChange={(e) => setIcon(e.target.value)}
        placeholder="emoji"
        className="h-8 w-16 shrink-0 text-center text-base"
        maxLength={4}
        // 图片模式下输入框隐藏:emoji 与图片互斥,清除此处的值会误伤图片配置
        style={isImageDataUrl(icon) ? { display: "none" } : undefined}
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
        控制请求日志"客户端"列的显示:左侧设置图标(输入 emoji 或点击"图片"选择本地图片,
        支持 png/jpg/gif/webp/bmp/ico/tiff 等常见格式,自动缩放为 64px),右侧自定义显示名称;
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
