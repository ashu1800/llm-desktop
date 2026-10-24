// 自动更新:tauri-plugin-updater(GitHub Releases latest.json)+ minisign 签名校验
import { useCallback, useEffect, useRef, useState } from "react";
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

/** 自动模式下周期性重查间隔:发版后无需重启即可被发现 */
const AUTO_RECHECK_INTERVAL_MS = 5 * 60 * 1000;

// 模块级共享:App(启动自动)与设置页(手动)两个 hook 实例共用同一次网络检查
type CheckOutcome = { update: Update | null } | { error: string };
let inFlightCheck: Promise<CheckOutcome> | null = null;

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
  const [state, setState] = useState<UpdaterState>({
    phase: "idle",
    currentVersion: null,
    nextVersion: null,
    notes: null,
    downloaded: 0,
    total: null,
    error: null,
    pendingUpdate: false,
  });
  // check() 返回的 Update 对象必须持有引用才能 downloadAndInstall
  const updateRef = useRef<Update | null>(null);
  const phaseRef = useRef<UpdatePhase>(state.phase);
  useEffect(() => {
    phaseRef.current = state.phase;
  }, [state.phase]);

  const applyEvent = (e: DownloadEvent) => {
    setState((s) => {
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
  };

  const runCheck = useCallback(async () => {
    setState((s) => ({ ...s, phase: "checking", error: null }));
    const outcome = await doCheck();
    if ("error" in outcome) {
      setState((s) => ({ ...s, phase: "error", error: `检查失败: ${outcome.error}` }));
      return;
    }
    updateRef.current = outcome.update;
    setState((s) =>
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
    const update = updateRef.current;
    if (!update) return;
    setState((s) => ({ ...s, phase: "downloading", downloaded: 0, total: null, error: null }));
    try {
      // 安装会经 NSIS /R 重启应用;先落盘标记,新实例据此强制显示界面
      // (否则静默启动设置会让更新后的窗口不出现)。失败不阻断更新。
      await invoke("mark_update_restart").catch(() => {});
      await update.downloadAndInstall(applyEvent);
      setState((s) => ({ ...s, phase: "ready" }));
    } catch (e) {
      setState((s) => ({ ...s, phase: "error", error: `下载/安装失败: ${e}` }));
    }
  }, []);

  const relaunchToUpdate = useCallback(async () => {
    await relaunch();
  }, []);

  // 当前版本 + 启动检查 + 每 5 分钟重查(失败静默,不打扰)
  useEffect(() => {
    let disposed = false;
    getVersion()
      .then((v) => !disposed && setState((s) => ({ ...s, currentVersion: v })))
      .catch(() => {});
    let timer: ReturnType<typeof setInterval> | undefined;
    if (auto) {
      runCheck().catch(() => {});
      timer = setInterval(() => {
        // 下载中/待重启时不重查,避免打断进行中的安装
        if (phaseRef.current === "downloading" || phaseRef.current === "ready") {
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
