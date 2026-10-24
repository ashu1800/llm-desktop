//! 自动更新后的一次性「显示主窗口」标记。
//!
//! 背景:Windows 上 tauri-plugin-updater 以 NSIS /P /R 安装,安装器杀掉当前
//! 进程后拉起新版本,并把原始启动参数经 /ARGS 原样转发(如开机自启的 --silent)。
//! 若用户开启了静默启动,更新拉起的新实例会命中静默逻辑,界面不显示——
//! 但「刚点过更新」的用户预期是看到新版本界面。
//!
//! 方案:前端发起 downloadAndInstall 前调用 mark_update_restart 落盘标记;
//! 新实例启动时 take_update_restart_flag() 消费(取走即删),强制显示主窗口。
//! 文件放数据目录(与 gateway.db 同级),随应用生命周期自然清理,不残留。

use std::path::{Path, PathBuf};

/// 标记文件名(数据目录下)
const FLAG_FILE: &str = "update-restart.flag";

fn flag_path(data_dir: &Path) -> PathBuf {
    data_dir.join(FLAG_FILE)
}

/// 落盘标记(下载安装前调用)。写入失败仅记日志,不阻断更新流程。
pub fn mark(data_dir: &Path) {
    if let Err(e) = std::fs::write(flag_path(data_dir), b"1") {
        log::warn!("写入更新重启标记失败: {e}");
    }
}

/// 取走标记:存在则删除并返回 true(调用方应显示主窗口)。
pub fn take(data_dir: &Path) -> bool {
    let path = flag_path(data_dir);
    match std::fs::remove_file(&path) {
        Ok(_) => true,
        // NotFound = 无标记(常态);其他删除失败也视为无标记,避免卡在「总是显示」
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => {
            log::warn!("读取更新重启标记失败: {e}");
            false
        }
    }
}
