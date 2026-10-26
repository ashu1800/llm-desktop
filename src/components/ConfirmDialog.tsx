// 主题化确认弹窗:取代 window.confirm——WebView2 原生脚本对话框不受应用主题控制,
// 且在 Tauri 异步环境下与后续动作存在竞态(曾出现"先执行后弹窗");Radix Dialog 全程受控。
// 用法:const confirm = useConfirm(); if (!(await confirm({ title, message }))) return;
import { createContext, useContext, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface ConfirmOptions {
  title: string;
  /** 正文说明,支持 JSX(如含强调的删除后果) */
  message: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作:图标与确认键取红色警示样式;默认 true */
  destructive?: boolean;
}

const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(
  () => Promise.resolve(false),
);

export function useConfirm() {
  return useContext(ConfirmContext);
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  // 极端情况下连续弹出:旧请求按"取消"落定,避免悬挂的 Promise
  const confirm = (o: ConfirmOptions) =>
    new Promise<boolean>((resolve) => {
      setPending((prev) => {
        prev?.resolve(false);
        return { ...o, resolve };
      });
    });

  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  const destructive = pending?.destructive ?? true;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={pending != null} onOpenChange={(o) => !o && settle(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5">
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ring-inset",
                  destructive
                    ? "bg-destructive/10 text-destructive ring-destructive/25"
                    : "bg-primary/10 text-primary ring-primary/25",
                )}
              >
                <AlertTriangle className="h-4 w-4" />
              </span>
              {pending?.title}
            </DialogTitle>
            <DialogDescription className="leading-relaxed">
              {pending?.message}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => settle(false)}>
              {pending?.cancelText ?? "取消"}
            </Button>
            <Button
              variant={destructive ? "destructive" : "default"}
              onClick={() => settle(true)}
            >
              {pending?.confirmText ?? (destructive ? "确认删除" : "确认")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}
