// 自动更新:tauri-plugin-updater(GitHub Releases latest.json)+ minisign 签名校验
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";

export type UpdatePhase =
  | "idle" // 未检查
  | "checking"
  | "available" // 有更新,待下载
  | "downloading"
  | "ready" // 下载安装完成,待重启
  | "uptodate"
  | "error";

export interface UpdaterState {
  phase: UpdatePhase;
  currentVersion: string | null;
  nextVersion: string | null;
  notes: string | null;
  /** 已下载字节数(Started 事件给出总长;总长未知时 total 为 null) */
  downloaded: number;
  total: number | null;
  /** 含来源前缀:"检查失败:…" / "下载/安装失败:…" */
  error: string | null;
  /** check 已发现新版本:下载失败可原地重试,无需重新检查 */
  pendingUpdate: boolean;
}

/** 自动模式下周期性重查间隔:发版后约 1 分钟内即可被发现 */
const AUTO_RECHECK_INTERVAL_MS = 60 * 1000;

// 模块级共享:App(启动自动)与设置页(手动)两个 hook 实例共用同一次网络检查
type CheckOutcome = { update: Update | null } | { error: string };
let inFlightCheck: Promise<CheckOutcome> | null = null;

// ---------- 模块级单例状态 ----------
// App 与 SettingsPage 各挂一个 useUpdater;若各自持有 state,一边下载中另一边
// 仍显示"立即更新",可并发 downloadAndInstall(二次拉起安装器)、重复 toast。
// state/sharedUpdate 收敛到模块级,订阅计数为 0 时状态保留(下次挂载继续显示)。

let sharedState: UpdaterState = {
  phase: "idle",
  currentVersion: null,
  nextVersion: null,
  notes: null,
  downloaded: 0,
  total: null,
  error: null,
  pendingUpdate: false,
};
let sharedUpdate: Update | null = null;
const subscribers = new Set<(s: UpdaterState) => void>();

function setShared(updater: (s: UpdaterState) => UpdaterState) {
  sharedState = updater(sharedState);
  for (const fn of subscribers) fn(sharedState);
}

function doCheck(): Promise<CheckOutcome> {
  if (!inFlightCheck) {
    inFlightCheck = (async () => {
      try {
        const update = await check();
        return { update };
      } catch (e) {
        return { error: String(e) };
      } finally {
        inFlightCheck = null;
      }
    })();
  }
  return inFlightCheck;
}

export function useUpdater(options?: { auto?: boolean }) {
  const auto = options?.auto ?? false;
  const state = useSyncExternalStore(
    (onStoreChange) => {
      subscribers.add(onStoreChange);
      return () => subscribers.delete(onStoreChange);
    },
    () => sharedState,
    () => sharedState,
  );
  // 稳定引用:所有实例共享同一份闭包,操作作用于共享状态
  const applyEvent = useCallback((e: DownloadEvent) => {
    setShared((s) => {
      switch (e.event) {
        case "Started":
          return { ...s, phase: "downloading", downloaded: 0, total: e.data.contentLength ?? null };
        case "Progress":
          return { ...s, downloaded: s.downloaded + e.data.chunkLength };
        case "Finished":
          return { ...s, phase: "ready" };
        default:
          return s;
      }
    });
  }, []);

  const runCheck = useCallback(async () => {
    // 全局"下载中/待重启"时拒绝检查,防另一实例并发打断安装
    if (sharedState.phase === "downloading" || sharedState.phase === "ready") {
      return;
    }
    setShared((s) => ({ ...s, phase: "checking", error: null }));
    const outcome = await doCheck();
    if ("error" in outcome) {
      setShared((s) => ({ ...s, phase: "error", error: `检查失败: ${outcome.error}` }));
      return;
    }
    sharedUpdate = outcome.update;
    setShared((s) =>
      outcome.update
        ? {
            ...s,
            phase: "available",
            nextVersion: outcome.update.version,
            notes: outcome.update.body ?? null,
            pendingUpdate: true,
          }
        : { ...s, phase: "uptodate", pendingUpdate: false },
    );
  }, []);

  const downloadAndInstall = useCallback(async () => {
    const update = sharedUpdate;
    if (!update) return;
    setShared((s) => ({ ...s, phase: "downloading", downloaded: 0, total: null, error: null }));
    try {
      // 安装会经 NSIS /R 重启应用;先落盘标记,新实例据此强制显示界面
      // (否则静默启动设置会让更新后的窗口不出现)。失败不阻断更新。
      await invoke("mark_update_restart").catch(() => {});
      await update.downloadAndInstall(applyEvent);
      setShared((s) => ({ ...s, phase: "ready" }));
    } catch (e) {
      setShared((s) => ({ ...s, phase: "error", error: `下载/安装失败: ${e}` }));
    }
  }, [applyEvent]);

  const relaunchToUpdate = useCallback(async () => {
    await relaunch();
  }, []);

  // 当前版本(一次性,写入共享态) + 启动检查(仅 auto 实例) + 周期重查
  useEffect(() => {
    let disposed = false;
    getVersion()
      .then((v) => !disposed && setShared((s) => ({ ...s, currentVersion: v })))
      .catch(() => {});
    let timer: ReturnType<typeof setInterval> | undefined;
    if (auto) {
      runCheck().catch(() => {});
      timer = setInterval(() => {
        // 下载中/待重启时不重查,避免打断进行中的安装
        if (sharedState.phase === "downloading" || sharedState.phase === "ready") {
          return;
        }
        runCheck().catch(() => {});
      }, AUTO_RECHECK_INTERVAL_MS);
    }
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
    };
  }, [auto, runCheck]);

  return { state, runCheck, downloadAndInstall, relaunchToUpdate };
}
