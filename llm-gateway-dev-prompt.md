> 项目代号:`llm-desktop`(可自行改名)。
> 文档中所有"默认值"均为拍板决策,实现时不要随意更改;未覆盖的细节参考 one-api / new-api 的行业惯例,并在 README 的"决策记录"中登记。

---

## 0. 一句话定位

基于 **Tauri 2 + Rust + React 18** 的本地 LLM API 网关桌面应用(Windows 优先,兼容 macOS/Linux):
对外提供 **OpenAI(chat/completions + Responses API)/ Anthropic / Gemini 三协议四入口并自动互转**(Claude Code、Codex CLI、Gemini CLI、Cherry Studio、ChatBox、Cline 等主流客户端开箱即用),对内对接任意数量的上游中转站(OpenAI 兼容 / Anthropic 原生 / Gemini 原生),
提供**自建密钥分发、多渠道按序路由、熔断 / 冷却 / 故障转移、渠道级模型映射、全局统一计价、请求级统计面板**。

## 1. 技术栈(强制,不得替换)

| 层 | 选型 |
|---|---|
| 桌面外壳 | Tauri 2(插件:single-instance、autostart、tray、dialog、log、updater) |
| 后端语言 | Rust(stable,tokio 异步运行时) |
| 数据面 HTTP 服务 | axum(内嵌在 Tauri 主进程内,与 UI 同进程) |
| 上游请求 | reqwest(开 `stream` 特性,连接池复用,支持 HTTP/SOCKS 代理) |
| 数据库 | SQLite(sqlx,compile-time checked 查询 + migrations) |
| 前端框架 | React 18 + TypeScript + Vite |
| 样式 | Tailwind CSS 3 + shadcn/ui(Radix 原语 + CVA + tailwind-merge + clsx) |
| 数据获取 / 状态 | TanStack Query(封装 Tauri invoke)+ Zustand |
| 表格 / 图表 / 拖拽 | TanStack Table + @tanstack/react-virtual、Recharts、@dnd-kit |
| 其他 | lucide-react(图标)、sonner(toast)、framer-motion(动画) |

**约束**:
- 不得引入文档之外的重量级依赖(微服务、消息队列、GraphQL、独立数据库进程等)。
- 前端不得直连 HTTP 端口做管理操作;管理面一律走 Tauri IPC。
- UI 默认简体中文,文案集中管理,预留 i18n 结构。

## 2. 总体架构

```
┌────────────────────────── Tauri 进程 ──────────────────────────┐
│                                                                │
│  ┌─ 控制面(管理)──────────┐   ┌─ 数据面(代理)───────────┐  │
│  │ React SPA (WebView)      │   │ axum server : 可配置端口   │  │
│  │  ├─ 渠道管理             │──▶│  └▶ auth 中间件(自建密钥) │  │
│  │  ├─ 密钥管理             │IPC│     └▶ 路由选择(密钥的渠道 │  │
│  │  ├─ 定价管理             │   │        有序列表 + 熔断状态) │  │
│  │  ├─ 统计/日志面板        │   │        └▶ 渠道级模型映射    │  │
│  │  └─ 设置                 │   │           └▶ 协议转换器     │  │
│  └──────────────────────────┘   │              └▶ reqwest 转发│  │
│                                 │   SSE 流式逐 chunk 互转回写 │  │
│  ┌─ 公共(Rust)────────────┐   │  计量计费 → 异步日志队列     │  │
│  │ 熔断器 · 定价引擎        │   └──────────────┬───────────────┘  │
│  │ 配置存储 · SQLite(sqlx) │◀──────────────────┘ 批量写入        │
│  │ 托盘 · 自启 · 静默启动    │                                     │
│  └──────────────────────────┘                                     │
└────────────────────────────────────────────────────────────────────┘
        ▲                                    ▲
        │ IPC(管理)                        │ HTTP(OpenAI chat/Responses·Anthropic·Gemini)
   桌面管理界面          Claude Code / Codex / Gemini CLI / Cherry Studio 等客户端
```

**硬性架构约束**:
1. 数据面(代理请求)完全在 Rust 进程内完成,**不经过前端与 IPC**。
2. 流式转发逐 chunk 处理:上游收到一个 SSE 事件立刻转换并写回客户端,**禁止整体缓冲后再回放**。
3. 请求日志先入内存队列(tokio mpsc),由独立任务**批量异步**写 SQLite,队列满时丢弃日志但绝不阻塞响应。
4. 管理操作(增删渠道、改配置)不允许中断正在进行中的请求;配置热生效。

## 3. 功能需求

### 3.1 服务与系统集成

- **自定义端口**:默认 `8787`;设置页可改,保存前检测占用,成功后热重启监听并 toast 提示;顶栏常显当前监听状态(地址:端口 + 运行中/已停止)。
- **监听地址**:默认 `127.0.0.1`;可改为 `0.0.0.0` 供局域网使用,切换时弹确认警告(密钥将暴露给局域网;Windows 首次监听 `0.0.0.0` 会触发系统防火墙授权弹窗,需在提示文案中告知用户允许)。
- **开机自启**:Windows 写注册表 `HKCU\...\CurrentVersion\Run`(优先用 tauri-plugin-autostart;若插件不支持携带启动参数,则自行写注册表,值中带 `--silent`);设置页开关,实时生效。
- **静默启动**:`--silent` 参数或设置项"启动时最小化到托盘"→ 启动不弹窗口,仅托盘运行;**开机自启时强制按静默处理**。
- **系统托盘**:
  - 图标状态色:绿=服务运行、灰=服务停止、红=服务运行但所有启用渠道均熔断/异常;
  - 菜单:打开主界面、启动/停止代理服务、开机自启(勾选)、退出。
- **关闭行为**:点窗口关闭 = 隐藏到托盘并保持代理运行(设置项可改为真正退出);单实例,二次启动唤起已有窗口。
- **服务可启停**:托盘与设置页可手动停止/启动代理监听(不影响管理界面)。

### 3.2 渠道(上游)管理

字段:名称、**协议类型**(`openai` / `anthropic` / `gemini`)、Base URL、**API Key 池**(可存多个,请求时轮询)、备注、启用开关、
代理设置(默认走系统/直连/自定义 HTTP(S)_PROXY)、超时覆盖(连接/首字/流空闲,秒)、
**支持的模型列表**(空 = 不限制)、**模型映射表**、熔断参数覆盖(默认跟随全局)、连通状态。

- **连通性测试**:按钮触发,拉取模型列表(或发一条 `ping` 测试消息),展示成功/失败与耗时。
- **模型映射**:渠道级 `入站模型名 → 上游模型名`,精确匹配;未命中则原样透传。渠道能否服务某模型 = 支持列表判定(用**映射后**的名字判断)。
- 渠道列表展示实时健康态徽标:正常 / 熔断中(剩余冷却秒数)/ 冷却探测中 / 已禁用;提供"手动恢复"按钮。
- API Key 在表格中掩码显示(`sk-abc***xyz`),可点击复制;入库明文存储(本地单机软件,备份需要),但**日志与导出的诊断信息中一律打码**。

### 3.3 密钥(自建 API Key)管理

- 生成格式 `sk-gw-` + 32 位随机 hex;创建时一次性展示明文并可复制,此后列表仅显示名称 + 前后 4 位掩码。
- 库内存明文(UI 掩码),校验用常量时间比较;**按用户拍板:不做额度、有效期、速率限制、模型白名单**。
- 每个密钥配置:**可用渠道有序列表**(从启用渠道中多选 + 拖拽排序,顺序即故障转移顺序)。
- 其他字段:名称、备注、启用开关、创建时间、最近使用时间。
- 删除密钥不删除历史日志(日志冗余存 key_name)。

### 3.4 路由与容错(核心)

**路由选择**:请求按 `密钥的渠道有序列表` 从前到后选第一个"启用 + 未熔断 + 支持该模型"的渠道;全部不可用 → 返回 503(按入口协议的错误格式)。

**故障转移(failover)**:
- 触发条件(满足其一即切下一渠道):TCP/TLS 连接失败、连接超时、**首字超时**、HTTP 5xx、429、响应体在生成任何内容前出错。
- **重试边界(重要)**:仅在尚未向客户端写回任何字节(流未开始)时才可重试;流式已开始后上游中断 → 直接结束并记错误日志,**不重试**(避免内容重复计费与客户端错乱)。
- **渠道内密钥轮换**:上游返回 401/403(密钥失效)或 429(限流)时,若该渠道密钥池还有未尝试过的密钥,**先轮换密钥重试本渠道一次**,仍失败才计入渠道级失败并触发故障转移(避免单把坏 Key 拖垮整个渠道的熔断计数)。
- 每次尝试(渠道名、状态、耗时、错误)记录进日志的 `attempts` 数组;最终响应头加 `X-GW-Channel: <渠道名>` 与 `X-GW-Attempts: <n>` 便于排查。

**熔断器(渠道维度,全局共享状态机)**:
- 统计:滑动窗口 60 秒内的成功/失败;失败判定同 failover 触发条件。
- 打开条件:连续失败 ≥ 5 次,**或**窗口内样本 ≥ 10 且失败率 ≥ 50%(默认值,渠道可覆盖)。
- 冷却:打开后进入冷却期,默认 60 秒;连续熔断按指数退避 60→120→240…上限 600 秒,成功关闭后计数重置。
- 半开:冷却结束进入 half-open,放行 1 个真实请求探测;成功 → 关闭;失败 → 重新打开并翻倍冷却。
- 429 特殊处理:除计失败外,若上游带 `Retry-After` 头,将该渠道的冷却期设为该值(上限 10 分钟)。

**超时默认值**(渠道可覆盖):连接 10s、**首字 TTFT 120s**(从发起上游请求到收到第一个 SSE data 字节;注意与 failover 组合时,对"实际已受理但极慢"的上游重试会产生重复计费,慢渠道应调大此值而非依赖默认)、**流式空闲 120s**(相邻两次上游数据之间的最大间隔,**代替"总时长上限"——长思考/长输出的合法请求可能超过 10 分钟,总时长硬顶会误杀正在生成的流**);非流式请求总时长 600s;超时一律记为失败。

### 3.5 入口协议与自动互转(三协议四入口)

**入口端点**(对客户端暴露,统一走自建密钥认证;所有路由必须容忍并忽略未知 query 参数,如 Claude Code 会在 `/v1/messages` 后附加 `?beta=true`):
- `POST /v1/chat/completions`(OpenAI,支持 `stream: true`)
- `POST /v1/responses`(OpenAI **Responses API**,Codex CLI 默认线协议,支持 `stream: true`;支持细则见本节末尾)
- `POST /v1/messages`(Anthropic,支持 `stream: true`)
- `POST /v1/messages/count_tokens`(本地估算后按 Anthropic 格式返回,不转发)
- Gemini 原生入口组(Gemini CLI 可直接将 base URL 指向本网关):`GET /v1beta/models`、`POST /v1beta/models/{model}:generateContent`、`:streamGenerateContent?alt=sse`、`:countTokens`(本地估算;细则见本节末尾)
- `GET  /v1/models`(**双格式自适应**:同一路径两种客户端都会调用,按认证头区分——`x-api-key` 头返回 Anthropic `list_models` 格式 `{data,has_more,first_id,last_id}`,`Bearer` 头返回 OpenAI `{object:"list",data}` 格式;聚合该密钥可用渠道的模型名并去重;models 列表为空(不限)的渠道无法枚举,不参与聚合、仅作转发兜底)
- `GET /healthz`(网关自身健康检查,免认证)
- 数据面全路由放行 CORS(`Access-Control-Allow-Origin: *` + 处理 OPTIONS 预检),否则浏览器类客户端(网页版 ChatUI)直连会被浏览器拦截

**认证**:同时接受 `Authorization: Bearer sk-gw-xxx`、`x-api-key: sk-gw-xxx`(Anthropic 系客户端)与 `x-goog-api-key: sk-gw-xxx`(Gemini 系客户端),`?key=` query 参数同样接受;均使用常量时间比较。

**转换矩阵**(4 个入口 × 3 种上游 = 12 种组合,全部支持;同协议且模型无需映射时走直通优化,不做无谓序列化)。实现上必须以**统一中间表示(IR)**为核心:定义 CanonicalRequest / CanonicalMessage / CanonicalChunk(流式事件)与 usage 结构,每个协议只实现"协议 ↔ IR"一对纯函数适配器,入口→上游 = 适配器串联。**禁止写 12 条点对点转换路径**——否则每新增一种协议,转换代码数量按组合数爆炸,不可维护:

| 入口 \ 上游 | OpenAI 兼容(chat) | Anthropic 原生 | Gemini 原生 |
|---|---|---|---|
| OpenAI chat 入口 | 直通 | 转换 | 转换 |
| OpenAI Responses 入口 | 转换 | 转换 | 转换 |
| Anthropic 入口 | 转换 | 直通 | 转换 |
| Gemini 入口 | 转换 | 转换 | 直通 |

**转换规则要点**:
- system:Anthropic 顶层 `system` ↔ OpenAI system message ↔ Gemini `systemInstruction`。
- 多轮消息、role 映射;assistant 内容块(text / tool_use / tool_result)↔ OpenAI tool_calls ↔ Gemini functionCall/functionResponse。
- 参数透传:max_tokens、temperature、top_p、stop(_sequences);Anthropic `thinking.budget_tokens` ↔ OpenAI `reasoning_effort` 尽力映射,不可转换字段安全丢弃并在日志记录 `dropped_fields`。
- **Prompt Caching 直通(重要)**:Anthropic 入口 → Anthropic 上游时,请求体中的 `cache_control` 字段与 `anthropic-beta` 请求头必须原样透传——这是"缓存写/缓存读"token 的唯一来源,丢弃则统计面板的缓存列恒为 0;跨协议转换(→ OpenAI/Gemini)时丢弃 `cache_control` 并记入 `dropped_fields`。
- tool_choice 映射:OpenAI `"auto"/"required"/"none"/{type:"function",...}` ↔ Anthropic `{type:"auto"}/{type:"any"}/{type:"tool"}` ↔ Gemini `toolConfig`;目标协议无法表达时降级为 auto 并记 `dropped_fields`。
- Gemini 上游的 URL 构建与鉴权:模型名拼在路径里 `POST {base}/v1beta/models/{model}:generateContent`(流式为 `:streamGenerateContent?alt=sse`),鉴权用 `x-goog-api-key` 请求头;**模型映射必须重写路径中的模型名**,不是改请求体。
- **SSE 流式互转**:OpenAI `data: {...}` / `[DONE]` ↔ Anthropic `message_start` / `content_block_delta` / `message_delta` / `message_stop` 事件流 ↔ Gemini `alt=sse` 的 `streamGenerateContent`。SSE 保活:同协议直通时上游 `ping` 事件(Anthropic)/ `: keep-alive` 注释行(OpenAI)原样转发;跨协议转换时吞掉并改为按 15s 间隔自行发送注释行,防止客户端或中间层因空闲断连(长思考模型首字前可能静默数分钟)。
- **usage 双向映射**:OpenAI `prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens`;Anthropic `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`;Gemini `usageMetadata`。缓存信息尽量保留,缺失记 0。向 OpenAI 兼容上游自动注入 `stream_options: {include_usage: true}` 以拿到流式 usage;若上游对未知字段报错则去掉重发一次,仍拿不到则走本地估算。
- 上游错误透传:保持**入口协议**的错误 JSON 结构(openai error 对象 / anthropic `{type:"error",...}`),状态码原样。
- 网关自身错误(无可用渠道、认证失败):按入口协议格式返回,503 / 401。

**Responses API(`/v1/responses`)支持细则**(Codex CLI 的默认线协议,必须完整支持,不能只做半份):
- 无状态实现:忽略 `store` 参数(恒按 false 处理,不落盘);`previous_response_id` 用进程内 LRU(缓存最近 500 条响应的 input/output)拼接完整上下文,未命中(网关重启后/超出容量)返回 400 并附明确提示"请携带完整 input 重试";`GET /v1/responses/{id}` 直接 404(主流客户端均使用流式,不轮询)。
- 请求映射:`instructions` → system;`input` 数组各项(message / function_call / function_call_output / reasoning)→ IR;历史中的 `reasoning` 项(含 `encrypted_content`)跨协议转发时丢弃并记 `dropped_fields`(chat/completions 上游无法使用加密推理内容);`reasoning.effort`(minimal/low/medium/high)↔ Anthropic `thinking.budget_tokens` ↔ Gemini `thinkingConfig` 尽力映射,无法表达时取最接近档位。
- 出站 SSE 必须合成**完整官方事件序列**(`sequence_number` 严格递增):`response.created` → `response.in_progress` → `response.output_item.added` → 文本走 `response.content_part.added` + `response.output_text.delta`*(可多轮 output_item)/ 工具调用走 `response.function_call_arguments.delta`* → `response.output_item.done` → `response.completed`(带 usage)。OpenAI SDK 与 Codex CLI 都按此事件流驱动内部状态机,**缺事件或时序错乱客户端直接挂**。
- 上游 delta 携带 `reasoning_content`(DeepSeek/R1 风格)时,映射为 `response.reasoning_summary_text.delta` 事件;`include`、`parallel_tool_calls` 等无法满足的字段安全忽略并记录。

**Gemini 原生入口细则**(Gemini CLI 将 base URL 指向本网关即可用):
- `GET /v1beta/models` 返回 Gemini 列表格式 `{models:[{name:"models/<id>",displayName,...}]}`,按该密钥可用渠道聚合去重(与 `/v1/models` 同源)。
- 路由中的 `{model}` 即入站模型名,照常走模型映射与路由选择;`:countTokens` 本地估算返回 `{usage:{totalTokens:N}}`,不转发。
- SSE 出站按 `data: {GenerateContentResponse}` 逐块回写,`usageMetadata` 在末块回填;非流式 `generateContent` 同样支持。

### 3.6 定价引擎(全局定价表)

- 价格表字段:模型名(唯一)、输入价、输出价、缓存读价、缓存写价(单位:元 / 百万 token);支持按 `prefix*` 通配兜底行(精确优先,通配取最后匹配)。
- **费用公式**:
  `cost = (prompt − cache_read − cache_write) × 输入价 + cache_read × 缓存读价 + cache_write × 缓存写价 + completion × 输出价`(单价均 /1M)。
- 计费 token 来源:优先上游返回的 usage;流式取最终 usage 块;上游不返回 usage 时本地估算——用 `tiktoken-rs`(cl100k_base)计数,BPE 不兼容的模型按 UTF-8 字节数 ÷ 3.75 近似,**日志标记 `estimated=true`**(禁止为估算引入按模型下载词表的重量级 tokenizer)。
- 未定价模型:请求成功但价格表无该模型 → 正常返回,同时计入"未定价模型"清单(统计页徽标提醒),可一键补录并回填历史记录费用。
- 货币:内部以人民币分(整数)存储,界面显示 ¥,保留 6 位小数。

### 3.7 统计面板与请求日志(对标截图)

**请求日志表格列**(与截图一致,自左向右):

| 列 | 内容 |
|---|---|
| 请求时间 | HH:mm:ss,悬停显示完整日期;默认按时间倒序 |
| 模型 | 模型名徽标 + 附加标签(取请求中的 `reasoning_effort` / thinking 档位,显示为 max/high 等彩色徽标,无则不显) |
| 渠道 | 渠道名(带图标);若发生重试,追加 `×n` 角标 |
| 词元 | `↑输入`、`↓输出`、`⟳缓存写`(蓝色),第二行 `缓存命中 %`(= cache_read / 总输入);千分位 K 缩写 |
| 任务耗时 | `首字 TTFT`(流式)/ `耗时 总时长` 两行;非流式首字显示 `—` |
| 费用 | ¥ 计费结果(估算值加 `~` 前缀) |
| 速度 | `流` 徽标 + `N tok/s`(输出 token / 总时长);非流式显示 `非流` |
| 状态 | `● 200` 绿 / 4xx 橙 / 5xx 红;网关错误显示 `GW-503` 等 |
| 密钥 | 密钥名徽标 |
| 客户端 | User-Agent 识别(Claude Code / Codex CLI / Gemini CLI / Cherry Studio / ChatBox / LobeChat / OpenWebUI / Cline·Roo Code / Dify / 其他),未知显示原始 UA 前 20 字符 |
| 操作 | 详情按钮 |

**筛选器**:时间范围(今天/近7天/近30天/自定义)、密钥、渠道、模型、状态(成功/失败)、关键字(模型名/错误信息);组合筛选,服务端分页(虚拟滚动)。

**汇总卡片**(筛选范围联动):请求数、总费用、平均首字延迟、平均输出速度、错误率、当前熔断中的渠道数。

**图表**(Recharts):调用量与费用双轴趋势(按小时/按日切换)、渠道请求占比饼图、模型 Top 10 柱状图。

**详情抽屉**:请求头/响应头(Authorization 打码)、请求体与响应体(默认各截断 32KB,可设置完整保存开关)、重试链(attempts:每次尝试的渠道、耗时、错误)、usage 明细、计费明细公式、协议转换信息(入口协议→上游协议、丢弃字段)。

- **实时性**:日志列表默认 10s 轮询 + 手动刷新开关;熔断状态变化、服务启停、端口变更通过 Tauri event(频道 `gateway://events`)推送到前端,渠道徽标与顶栏状态即时更新,不依赖刷新。
- 流式请求的 `resp_snapshot` 存放拼接还原后的最终文本(同样受 32KB 截断限制),不是逐 chunk 原始流。

**数据保留**:日志默认保留 90 天(可配),每日凌晨自动清理;设置页可一键清空。

### 3.8 设置页

端口、监听地址、开机自启、静默启动、关闭行为、日志保留天数、完整报文保存开关、
熔断全局默认参数(窗口/阈值/失败率/冷却/退避上限)、各超时默认值、
主题(亮/暗/跟随系统)、配置导出/导入(JSON,含渠道+密钥+定价+设置;日志不导出;导入前二次确认)。

## 4. 数据模型(SQLite,sqlx migrations)

```sql
channels(          id PK, name, protocol TEXT CHECK(openai|anthropic|gemini),
  base_url, api_keys JSON /* 数组,轮询 */, enabled BOOL, proxy TEXT,
  models JSON /* 支持的模型,空=不限 */, model_map JSON /* {入站:上游} */,
  timeout_override JSON NULL, breaker_override JSON NULL, remark, created_at, updated_at)

api_keys(          id PK, name, key TEXT UNIQUE, enabled BOOL, channels JSON /* 有序渠道id数组 */,
  remark, created_at, last_used_at)

model_prices(      id PK, pattern TEXT UNIQUE /* 精确名或 prefix* */,
  input REAL, output REAL, cache_read REAL, cache_write REAL, /* 元/百万token */
  updated_at)

request_logs(      id PK, ts INT, key_id, key_name, channel_id, channel_name,
  model, mapped_model, tag TEXT, protocol_in, protocol_up,
  status INT, is_stream BOOL, attempts JSON, error TEXT,
  prompt_tokens INT, completion_tokens INT, cache_read INT, cache_write INT,
  estimated BOOL, ttft_ms INT, total_ms INT, speed REAL, cost INTEGER /* 分 */,
  client TEXT, req_snapshot TEXT NULL, resp_snapshot TEXT NULL,
  -- 索引: ts DESC, key_id+ts, channel_id+ts, model+ts )

settings(          key PK, value JSON )
```

SQLite 连接统一开启:`journal_mode=WAL`、`busy_timeout=5000`、`synchronous=NORMAL`、外键约束(代理转发与日志写入并发访问,不开 WAL 会出现 `database is locked`);所有时间戳存 UTC epoch 毫秒,前端按本地时区展示。

## 5. Rust 模块划分

```
src-tauri/src/
├── main.rs / lib.rs        // Tauri builder、托盘、自启、单实例
├── server/                 // axum 路由、auth 中间件、错误响应(按入口协议)
├── proxy/                  // 请求处理主流程、流式中继(relay)、failover 循环
├── transform/              // ir.rs(统一中间表示)+ openai.rs / responses.rs / anthropic.rs / gemini.rs / sse.rs(全部为"协议↔IR"纯函数适配器,重点单测)
├── router/                 // 渠道选择(密钥有序列表 × 熔断态 × 模型支持)
├── breaker/                // 熔断状态机 Closed/Open/HalfOpen、滑动窗口、指数退避
├── billing/                // 定价匹配、费用计算、未定价收集、tokenizer 估算
├── store/                  // sqlx 连接、migrations、各 repo、日志批量写入任务(mpsc)
├── commands/               // 全部 #[tauri::command](CRUD、测试渠道、统计查询、导入导出)
└── tray.rs / autostart.rs
```

状态共享:`Arc<AppState>`(熔断器表、渠道/密钥/定价的 `RwLock` 缓存、日志 mpsc 发送端、服务句柄);配置变更 → 更新缓存 + 原子热生效。

## 6. 前端页面

侧边栏布局:仪表盘 / 请求日志 / 渠道管理 / 密钥管理 / 模型定价 / 设置;顶栏:服务状态点 + 端口 + 托盘同款启停按钮 + 主题切换。

- **仪表盘**:汇总卡片 + 三张图表 + 熔断渠道告警条 + 未定价模型提醒。
- **请求日志**:3.7 全部内容;表格用 TanStack Table + 虚拟滚动,列宽可调;详情用右侧 Sheet 抽屉。
- **渠道管理**:表格 + 新建/编辑 Dialog(协议类型切换时切换 Base URL 占位符;映射表用可增删的键值对编辑器;密钥池可增删);每行操作:测试、启停、立即恢复、编辑、删除。
- **密钥管理**:表格 + 创建 Dialog(生成明文一次性展示)+ 可用渠道多选 + @dnd-kit 拖拽排序列表(序号即 failover 顺序)。
- **模型定价**:可编辑表格,支持通配行;未定价模型快捷补录。
- **设置**:分区表单;改端口/监听地址即时校验并热生效;导出/导入。

UI 细节:shadcn 组件 + sonner toast;暗色模式;所有金额 `¥0.006719` 格式;token 千位 K 缩写(1.23K);耗时 `<1s` 显示毫秒。

## 7. 请求主流程(实现基准)

```
客户端 → axum → auth(自建密钥,常量时间比较)
  → 解析入口协议 → 提取模型/流式标记/标签(reasoning_effort 等)
  → loop 遍历密钥渠道有序列表:
      跳过: 禁用 / 熔断 open / 模型不支持
      → 模型映射 → 构建上游请求(转换 + 上游密钥轮询)
      → reqwest 发送(超时控制)
      → 成功: 若流式 → 逐 chunk 转换回写,记录 TTFT;收尾取 usage
              若非流式 → 整体转换回写
      → 失败(未回写字节): 熔断器记账, 按 Retry-After 调整冷却, 继续下一渠道
      → 失败(已回写): 熔断器记账, 中断, 记错误日志, 退出
  → 全部失败: 按入口协议格式返回 503
  → 计费 → 组装日志(attempts/usage/cost/client)→ mpsc → 批量入库
```

## 8. 非功能需求

- **性能**:流式透传单 chunk 延迟 < 5ms(转换不计整包);100 并发转发内存稳定;SQLite 日志写入批量 ≥ 50 条/事务。axum `DefaultBodyLimit` 调大到 100MB——默认 2MB 会静默拒绝 200K token 级别的长上下文请求,表现为客户端收到莫名的 413。reqwest 开启 `gzip`/`deflate`/`brotli` 特性,上游启用压缩时自动解压。
- **可靠性**:网关崩溃重启后配置无损;熔断状态内存态即可(重启重置);日志队列满丢弃不阻塞。
- **安全**:默认仅监听 127.0.0.1;日志/详情/导出诊断中上游与自建密钥一律打码;切 0.0.0.0 必须确认。
- **质量**:`cargo clippy -D warnings` 与 `pnpm build` 零错误;transform 与 breaker 模块单元测试覆盖(含四入口 × 三上游经 IR 的 SSE round-trip、Responses 官方事件序列逐事件断言、熔断状态机全迁移路径);用 wiremock 写 failover/熔断集成测试。

## 9. 里程碑(按序实施,每个里程碑结束时代码必须可运行验证)

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 骨架 | Tauri 工程 + SQLite migrations + 设置页 + 端口热改 + 托盘 + 自启 + 静默启动 | 改端口即时生效;开机自启静默进托盘 |
| M2 直通代理 | OpenAI→OpenAI 直通(流式)+ 密钥认证 + `/v1/models` + `/healthz` | Cherry Studio 配置本网关可正常流式对话 |
| M3 渠道与容错 | 渠道/密钥 CRUD UI + 有序 failover + 熔断/冷却/半开 + attempts 记录 | 停掉主渠道自动切备用;错误超阈值熔断,冷却后半开恢复 |
| M4 Anthropic 入口 | `/v1/messages` + 三上游 SSE 互转 + count_tokens + cache_control 透传 | Claude Code 指向本网关,经 OpenAI 兼容上游正常流式输出,缓存列有数据 |
| M5 Responses/Gemini 入口 | IR 中间表示重构 + `/v1/responses`(Codex CLI)+ Gemini 原生入口(Gemini CLI)+ 两侧 SSE 事件合成 | Codex CLI 与 Gemini CLI 指向本网关:对话、流式、工具调用全部正常 |
| M6 计量计费 | 定价表 + 四类 token 统计 + 费用计算 + 未定价清单 + 日志入库 | 费用与手工按价格表计算一致,估算有标记 |
| M7 统计面板 | 日志表格(全列/筛选/虚拟滚动)+ 详情抽屉 + 汇总卡片 + 图表 | 复现截图全部信息列,筛选联动正确 |
| M8 打磨 | 暗色模式、导入导出、UA 识别、日志清理、README 各客户端接入示例、单测/集成测试补齐 | 验收清单全过 |

## 10. 验收清单

- [ ] 端口可自定义并热生效;占用检测有提示
- [ ] 开机自启 + 静默启动(仅托盘,无窗口)
- [ ] 四个入口(chat/completions、responses、messages、gemini)均可用自建密钥认证,错误格式符合各自入口协议
- [ ] Codex CLI(wire_api = responses)指向本网关:对话、流式、工具调用正常
- [ ] Gemini CLI 指向本网关:模型列表、对话、流式正常
- [ ] README 含 Claude Code / Codex CLI / Gemini CLI / Cherry Studio 的接入配置示例
- [ ] 密钥可配置有序渠道列表,拖拽即生效
- [ ] 渠道熔断后请求自动跳过;冷却后半开探测;可手动恢复
- [ ] 流式已开始后的上游中断不重试、不重复计费
- [ ] 渠道级映射生效;全局定价表计费正确,缓存 token 单独计价
- [ ] 日志页复现截图全部列:模型+标签、渠道、四类词元+命中率、首字/总耗时、费用、流式速度、状态码、密钥、客户端、详情
- [ ] 筛选(时间/密钥/渠道/模型/状态/关键字)联动汇总卡片与图表
- [ ] 导出的诊断信息中所有密钥打码
- [ ] 长流式请求(总时长 > 10 分钟)不会被超时机制误杀;流中途静默 > 120s 才判定失败
- [ ] Claude Code(Anthropic 入口)→ Anthropic 上游时,统计面板的缓存写/缓存读列有真实数据(cache_control 透传未丢)
- [ ] Claude Code 与 OpenAI 客户端各自请求 `GET /v1/models` 均能拿到本协议格式的列表
- [ ] 200K token 长上下文请求不被 413 拒绝

## 11. 决策记录(已与需求方确认,勿更改)

1. 入口:**三协议四入口**——OpenAI(chat/completions + Responses API)+ Anthropic(/v1/messages)+ Gemini(v1beta),经统一 IR 中间表示自动互转;主流客户端(Claude Code / Codex CLI / Gemini CLI / Cherry Studio 等)开箱即用。
2. 上游:**OpenAI 兼容、Anthropic 原生、Gemini 原生** 三种。
3. 模型映射放**渠道级**;定价放**全局模型价格表**;密钥不覆盖。
4. 密钥控制仅"可用渠道 + 顺序",**不做**额度/有效期/限流/模型白名单。
5. 重试仅发生在"未向客户端写回任何字节"之前。
6. 货币为人民币,价格单位:元 / 百万 token。
7. 自建密钥与上游 Key 本地明文存储(UI 掩码),导出备份含明文,由用户自行保管。
8. 流式请求**不设总时长硬顶**,只用"空闲超时"判定死亡;非流式才有总时长上限(修复原稿矛盾)。
9. `GET /v1/models` 同一路径双格式:按认证头 `x-api-key` / `Bearer` 自适应返回 Anthropic / OpenAI 格式。
10. Anthropic→Anthropic 直通必须透传 `cache_control` 与 `anthropic-beta`;跨协议时丢弃并记录。
11. 渠道密钥池在 401/403/429 时先轮换 Key 重试本渠道,再计入渠道级失败。
12. usage 估算用 tiktoken-rs(cl100k)近似,不为估算引入按模型下载词表的依赖。
13. TTFT 默认 120s:意识到"TTFT 超时 + failover"对慢上游有重复计费风险,可按渠道调大。
14. Responses API 做无状态实现:`store` 恒按 false 处理,`previous_response_id` 依赖进程内 LRU,不落盘。
15. OpenAI 兼容**上游**只走 chat/completions(不做上游方向的 Responses 透传);Responses 只作为**入口**协议,经 IR 转成三种上游。

## 12. 明确不做(v1 范围外,直接返回 404,不做半吊子支持)

- embeddings / images / audio / files / batches / realtime 等多模态与辅助端点(主流对话与 Agent 客户端均不使用)。
- 多用户、团队、权限体系;云端同步:定位是单机软件。
- 上游 OAuth(Claude Pro/Max 订阅账号 OAuth 授权):仅支持 API Key 型上游。
- 请求内容审计/敏感词过滤等企业功能。
