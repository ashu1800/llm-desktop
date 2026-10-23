// 自动更新:tauri-plugin-updater(GitHub Releases latest.json)+ minisign 签名校验
import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
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
  error: string | null;
}

const LAST_CHECK_KEY = "update.lastCheckMs";
/** 启动静默检查最小间隔(6 小时),手动检查不受限 */
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
  });
  // check() 返回的 Update 对象必须持有引用才能 downloadAndInstall
  const updateRef = useRef<Update | null>(null);
  const checking = useRef(false);

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
    if (checking.current) return;
    checking.current = true;
    setState((s) => ({ ...s, phase: "checking", error: null }));
    try {
      const update = await check();
      updateRef.current = update;
      setState((s) =>
        update
          ? {
              ...s,
              phase: "available",
              nextVersion: update.version,
              notes: update.body ?? null,
            }
          : { ...s, phase: "uptodate" },
      );
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
    } catch (e) {
      setState((s) => ({ ...s, phase: "error", error: String(e) }));
    } finally {
      checking.current = false;
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    setState((s) => ({ ...s, phase: "downloading", downloaded: 0, total: null, error: null }));
    try {
      await update.downloadAndInstall(applyEvent);
      setState((s) => ({ ...s, phase: "ready" }));
    } catch (e) {
      setState((s) => ({ ...s, phase: "error", error: String(e) }));
    }
  }, []);

  const relaunchToUpdate = useCallback(async () => {
    await relaunch();
  }, []);

  // 当前版本 + 启动静默检查(6h 节流;失败静默,不打扰)
  useEffect(() => {
    let disposed = false;
    getVersion()
      .then((v) => !disposed && setState((s) => ({ ...s, currentVersion: v })))
      .catch(() => {});
    if (auto) {
      const last = Number(localStorage.getItem(LAST_CHECK_KEY) ?? 0);
      if (Date.now() - last > AUTO_CHECK_INTERVAL_MS) {
        runCheck().catch(() => {});
      }
    }
    return () => {
      disposed = true;
    };
  }, [auto, runCheck]);

  // 静默检查发现新版本时由调用方决定提示方式:暴露 phase 变化即可
  return { state, runCheck, downloadAndInstall, relaunchToUpdate };
}
