# LLM Gateway(llm-desktop)

基于 **Tauri 2 + Rust + React 18** 的本地 LLM API 网关桌面应用(Windows 优先,兼容 macOS/Linux)。

对外提供 **OpenAI(chat/completions + Responses API)/ Anthropic / Gemini 三协议四入口并自动互转**(Claude Code、Codex CLI、Gemini CLI、Cherry Studio、ChatBox、Cline 等主流客户端开箱即用),对内对接任意数量的上游中转站(OpenAI 兼容 / Anthropic 原生 / Gemini 原生),提供自建密钥分发、多渠道按序路由、熔断/冷却/故障转移、渠道级模型映射、全局统一计价、请求级统计面板。

## 快速开始

环境要求:Node.js ≥ 18、pnpm ≥ 8、Rust stable(MSVC 工具链)、WebView2(Runtime,Win11 自带)。

```bash
pnpm install          # 安装前端依赖
pnpm tauri dev        # 开发模式(前端热更新 + Rust 增量编译)
pnpm tauri build      # 打包安装程序(NSIS)
```

数据目录:`%APPDATA%\com.llmgateway.desktop\gateway.db`(SQLite,WAL 模式)。

## 里程碑进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 骨架 | Tauri 工程 + SQLite migrations + 设置页 + 端口热改 + 托盘 + 自启 + 静默启动 | ✅ 完成 |
| M2 直通代理 | OpenAI→OpenAI 直通(流式)+ 密钥认证 + `/v1/models` + `/healthz` | ✅ 完成 |
| M3 渠道与容错 | 渠道/密钥 CRUD + 有序 failover + 熔断/冷却/半开 + attempts 记录 | ✅ 完成 |
| M4 Anthropic 入口 | `/v1/messages` + 三上游 SSE 互转 + count_tokens + cache_control 透传 | ✅ 完成 |
| M5 Responses/Gemini 入口 | IR 中间表示 + `/v1/responses`(官方事件序列 + LRU 链)+ Gemini 原生入口 | ✅ 完成 |
| M6 计量计费 | 定价表(通配)+ 四类 token 统计 + 费用计算 + 未定价清单 + 一键补录回填 | ✅ 完成 |
| M7 统计面板 | 日志表格(11 列)+ 筛选/分页 + 详情抽屉 + 汇总卡片 + 三图表 | ✅ 完成 |
| M8 打磨 | 配置导入导出、日志清理任务 + 一键清空、客户端接入示例 | ✅ 完成 |

## 客户端接入示例

所有入口共用同一套自建密钥(`sk-gw-…`,在"密钥管理"页生成);`{端口}` 即设置页端口(默认 8787)。

**Claude Code(Anthropic 入口)**

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=sk-gw-你的密钥
claude
```

**Codex CLI(Responses 入口)**

```toml
# ~/.codex/config.toml
[model_providers.gateway]
name = "gateway"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
env_key = "GATEWAY_KEY"
```
```bash
export GATEWAY_KEY=sk-gw-你的密钥
codex --profile 默认模型=gpt-5   # 模型名按渠道配置/映射填写
```

**Gemini CLI(Gemini 原生入口)**

```bash
export GEMINI_API_KEY=sk-gw-你的密钥
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8787
gemini   # 模型列表来自 GET /v1beta/models(按密钥可用渠道聚合)
```

**Cherry Studio / ChatBox / Cline 等(OpenAI 兼容入口)**

- API 地址:`http://127.0.0.1:8787/v1`
- API Key:`sk-gw-你的密钥`
- 模型:手动填写或从 `/v1/models` 拉取

> 提示:监听 `0.0.0.0` 时局域网设备可访问,请把地址中的 `127.0.0.1` 换成本机局域网 IP,并确认密钥分发范围。

## 发布与自动更新

采用 Tauri 官方更新机制:**GitHub Releases 托管产物 + `latest.json` 版本清单 + minisign 签名校验**。客户端启动时(6h 节流)与设置页手动检查 `releases/latest/download/latest.json`,发现新版本后下载安装包、校验签名、静默安装,重启即完成更新。

**发布新版本(维护者操作):**

```bash
# 1. 同步三处版本号:src-tauri/tauri.conf.json、package.json、src-tauri/Cargo.toml
#    (CI 会校验标签与 tauri.conf.json 版本一致,不一致直接构建失败)
# 2. 提交并打**附注**标签(CI 自动构建、签名、生成 latest.json、创建 Release)
git commit -am "release: v0.1.1"
git tag -a v0.1.1 -m "v0.1.1"   # 必须是附注标签:--follow-tags 只推附注标签
git push origin main --follow-tags
```

> Windows 客户端在更新安装阶段可能被安装器自动关闭并拉起新版本,属正常现象;若安装器未自动拉起,在「设置 → 软件更新」点"重启应用完成更新"。首个版本(v0.1.0)的发布本身就是对发布管线的完整验证;发布后打开已安装应用,在设置页点"检查更新"应显示"已是最新版本",即端点连通正常。

**一次性配置(已完成):**
- 签名密钥:`~/.tauri/llm-desktop.key`(私钥,**绝不入库**)与 `.key.pub`(公钥,已写入 `tauri.conf.json`);
- GitHub Secrets:`TAURI_SIGNING_PRIVATE_KEY`(私钥内容)与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`(空);
- 工作流:`.github/workflows/release.yml`,推送 `v*` 标签触发,产物为 NSIS 安装包 + `.nsis.zip` 更新包 + `.sig` 签名 + `latest.json`。

> 私钥丢失则无法再签名更新,已分发客户端只能手动重装;更换公钥同样需要用户重装。请妥善备份 `~/.tauri/llm-desktop.key`。

## 架构

```
┌────────────────────────── Tauri 进程 ──────────────────────────┐
│  控制面(React SPA,走 Tauri IPC)  │  数据面(axum,同进程)      │
│  渠道/密钥/定价/统计/设置          │  auth → 路由 → 转换 → 转发 │
│  公共:熔断器 · 定价引擎 · SQLite   │  SSE 逐 chunk 互转回写     │
└────────────────────────────────────────────────────────────────┘
```

硬性约束:数据面完全在 Rust 进程内(不经过前端与 IPC);流式逐 chunk 转发(禁止整体缓冲);请求日志经内存 mpsc 队列批量异步写库,队列满丢弃但不阻塞响应;管理操作不中断进行中的请求。

Rust 模块划分(见 `src-tauri/src/`):

```
server/    axum 路由、监听生命周期(端口热改 = 平滑重启)
proxy/     请求主流程、流式中继、failover 循环(M2+)
transform/ ir.rs 统一中间表示 + 各协议"协议↔IR"纯函数适配器(M4+)
router/    渠道选择(密钥有序列表 × 熔断态 × 模型支持)(M3+)
breaker/   熔断状态机 Closed/Open/HalfOpen(M3+)
billing/   定价匹配、费用计算、token 估算(M6+)
store/     sqlx 连接、migrations、日志批量写入任务
commands/  全部 #[tauri::command](管理面 IPC)
tray.rs / autostart.rs  托盘 / 开机自启
```

## M1 已实现

- **自定义端口 + 热生效**:默认 `8787`,保存前探测占用,平滑重启监听(旧监听 graceful shutdown);顶栏常显监听状态。
- **监听地址**:`127.0.0.1`(默认)/ `0.0.0.0`(切换需二次确认,提示防火墙授权)。
- **开机自启**:tauri-plugin-autostart 写注册表,启动参数附带 `--silent`;设置页开关实时生效,启动时自动校正注册表与设置一致。
- **静默启动**:`--silent` 参数或设置项 → 不弹窗口仅托盘;开机自启强制静默。
- **系统托盘**:绿=服务运行 / 灰=停止(红=全渠道熔断,M3 接入);菜单:打开主界面、启动/停止代理服务、开机自启(勾选)、退出;左键点击唤起主界面。
- **关闭行为**:点关闭 = 隐藏到托盘保持代理运行(设置可改为真正退出);单实例,二次启动唤起已有窗口。
- **SQLite**:五张表(channels / api_keys / model_prices / request_logs / settings)+ 索引;WAL + busy_timeout + NORMAL;所有时间戳 UTC epoch 毫秒。
- **数据面骨架**:axum `/healthz`(免认证)、全路由 CORS、`DefaultBodyLimit` 100MB(防长上下文 413)、按 OpenAI error 格式的 404 兜底。
- **设置页**:端口/监听地址/自启/静默/关闭行为/日志保留/完整报文/熔断全局默认/超时默认/主题(亮暗跟随系统),服务端钳制全部数值。

## 开发约定

- `pnpm build`(tsc + vite)与 `cargo clippy -D warnings` 必须零错误。
- UI 简体中文,文案随组件集中管理(预留 i18n 结构);金额 `¥0.006719` 格式;token 千位 K 缩写。
- 代码注释用中文,只解释"为什么"与代码无法自表达的约束。

## 决策记录

以下为与需求方确认的拍板决策(勿更改),及实施过程中的补充登记:

1. 入口:**三协议四入口**——OpenAI(chat/completions + Responses API)+ Anthropic(/v1/messages)+ Gemini(v1beta),经统一 IR 中间表示自动互转;主流客户端开箱即用。
2. 上游:**OpenAI 兼容、Anthropic 原生、Gemini 原生** 三种。
3. 模型映射放**渠道级**;定价放**全局模型价格表**;密钥不覆盖。
4. 密钥控制仅"可用渠道 + 顺序",**不做**额度/有效期/限流/模型白名单。
5. 重试仅发生在"未向客户端写回任何字节"之前。
6. 货币为人民币,价格单位:元 / 百万 token。
7. 自建密钥与上游 Key 本地明文存储(UI 掩码),导出备份含明文,由用户自行保管。
8. 流式请求**不设总时长硬顶**,只用"空闲超时"判定死亡;非流式才有总时长上限。
9. `GET /v1/models` 同一路径双格式:按认证头 `x-api-key` / `Bearer` 自适应返回 Anthropic / OpenAI 格式。
10. Anthropic→Anthropic 直通必须透传 `cache_control` 与 `anthropic-beta`;跨协议时丢弃并记录。
11. 渠道密钥池在 401/403/429 时先轮换 Key 重试本渠道,再计入渠道级失败。
12. usage 估算用 tiktoken-rs(cl100k)近似,不为估算引入按模型下载词表的依赖。
13. TTFT 默认 120s:意识到"TTFT 超时 + failover"对慢上游有重复计费风险,可按渠道调大。
14. Responses API 做无状态实现:`store` 恒按 false 处理,`previous_response_id` 依赖进程内 LRU,不落盘。
15. OpenAI 兼容**上游**只走 chat/completions;Responses 只作为**入口**协议,经 IR 转成三种上游。
16. **(实施登记)** sqlx 使用运行时查询(类型化元组/FromRow)+ `migrate!` 宏,不用 `query!` 编译期宏:避免构建依赖 DATABASE_URL / sqlx-cli;后续如需可切 offline 模式(`cargo sqlx prepare`)。
17. **(实施登记)** tauri-plugin-updater 列于技术栈,计划 M8 打磨阶段接入(需签名密钥与更新源)。
18. **(实施登记)** 应用/托盘图标为 `scripts/gen-icons.mjs` 生成的占位图形,正式视觉稿直接替换 `src-tauri/icons/` 同名文件即可。
19. **(实施登记)** 前端固定 Vite 5 + Tailwind 3(文档指定 Tailwind 3;Vite 5 兼容 Node 18+),路由用组件内 state 切换(桌面单窗口无深链需求)。
20. **(实施登记)** 熔断状态为进程内存态,重启重置(决策 8/§8 已确认);`settings` 表以单行 JSON(key="app")存储,`serde(default)` 保证前向兼容。
21. **(实施登记)** 请求日志不落盘请求/响应头(仅存体快照):网关密钥与上游凭据均经请求头传输,不存头即天然避免凭据落盘;详情抽屉相应不展示头部,PRD 的"Authorization 打码"以"不落盘"方式达成。
22. **(实施登记)** "虚拟滚动"以服务端分页实现(每页 ≤200 条,默认 50):桌面端单页数据量小,分页复杂度与内存占用更优。
23. **(实施登记)** ~~tauri-plugin-updater 暂不接入~~(已被决策 29 修订:已接入 GitHub Releases 自动更新)。
24. **(实施登记)** 日志保留清理为每小时幂等删除(等效"每日凌晨清理"的结果,无需定时器精确到凌晨);保留天数 0 不清理,默认 90 天。
25. **(实施登记)** 配置导入为**整表替换**(渠道/密钥/定价先清空后写入,单事务,失败整体回滚;密钥按旧→新渠道 id 重映射),设置覆盖保存;请求日志不导出不受导入影响。
26. **(实施登记)** 配置导入后复用 update_settings 的热生效路径(端口/监听平滑切换 + 开机自启同步),并清空按旧渠道 id 记账的熔断状态与密钥轮询起点。
27. **(实施登记)** 端口热改的旧监听在后台排水:进行中的请求继续在旧端口完成(符合"管理操作不中断请求"),设置命令立即返回,不阻塞 UI。
28. **(实施登记)** 上游中断/流内错误/空闲超时发生时,网关向客户端补发入口协议内的错误事件(OpenAI `data:{error}`+`[DONE]`、Anthropic `event:error`、Responses `type:error`、Gemini `data:{error}`),客户端 SDK 立即感知失败而非悬挂;流开始后的失败仍不重试、已产生 token 照常计费。
29. **(实施登记)** 自动更新采用 **GitHub Releases + latest.json + minisign 签名**(tauri-plugin-updater):更新端点指向 `releases/latest/download/latest.json`;签名私钥仅存本机 `~/.tauri/`(gitignore)与仓库 GitHub Secrets,公钥随配置入库;发布经 GitHub Actions 打 tag 自动构建,本地不手工出包。
24. **(实施登记)** 日志保留清理为每小时幂等删除(等效"每日凌晨清理"的结果,无需定时器精确到凌晨);保留天数 0 不清理,默认 90 天。
25. **(实施登记)** 配置导入为**整表替换**(渠道/密钥/定价先清空后写入,单事务,失败整体回滚;密钥按旧→新渠道 id 重映射),设置覆盖保存;请求日志不导出不受导入影响。
26. **(实施登记)** 配置导入后复用 update_settings 的热生效路径(端口/监听平滑切换 + 开机自启同步),并清空按旧渠道 id 记账的熔断状态与密钥轮询起点。
27. **(实施登记)** 端口热改的旧监听在后台排水:进行中的请求继续在旧端口完成(符合"管理操作不中断请求"),设置命令立即返回,不阻塞 UI。
28. **(实施登记)** 上游中断/流内错误/空闲超时发生时,网关向客户端补发入口协议内的错误事件(OpenAI `data:{error}`+`[DONE]`、Anthropic `event:error`、Responses `type:error`、Gemini `data:{error}`),客户端 SDK 立即感知失败而非悬挂;流开始后的失败仍不重试、已产生 token 照常计费。

## 明确不做(v1 范围外)

- embeddings / images / audio / files / batches / realtime 等多模态与辅助端点。
- 多用户、团队、权限体系;云端同步。
- 上游 OAuth(仅支持 API Key 型上游)。
- 请求内容审计/敏感词过滤。
