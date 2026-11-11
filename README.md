# 模型雷达（dsh-model-radar）

在输入框下方的 `conversation.composer.dock`（以及新会话空态行的 `conversation.hero.options`）里挂一个**旁路入口**：点开是「提供方在左、模型向右展开」的目录面板，支持搜索、最近使用、推理等级切换。

**两个槽都要挂，缺一个就有一段时间看不见入口。** 宿主在**新会话空态**渲染的是 hero 行，不是 composer dock 行——`conversation.composer.dock` 的渲染门槛是 `variant === "composer" && input !== undefined && sessionId !== undefined`，而新会话传的是 `variant: "hero"`，所以整行（含 activity / usage 等原生成员）都不渲染。`conversation.hero.options` 的门槛只是 `sessionId !== undefined`，且该槽今天为空。两槽互斥，不会同时出现。

**它不接管输入框工具栏里的官方模型选择器。** 官方那个按钮（`conversation.input.model`）始终在座、始终可用；本插件只是同一行 dock 里多出来的一颗胶囊。这是上一轮事故的直接后果——当时接管了 `conversation.input.model`（`replaceRisk: shadows-shipped-ui`）却没留退回开关，把官方按钮顶掉了。

## 安装

```powershell
# 用绝对路径安装（不要手改 profile 的 package.json / cordis.patch.yml，也不要在 profile 目录跑 pnpm）
plugin_manager install_bundle(target='E:\deepseek-workspace\dsh-model-radar')
```

装完 `dsh.profile.bundles` 里会出现 `dsh-model-radar`，`node_modules/dsh-model-radar` 是指回本目录的 junction。

**改完 `client.js` 必须整进程重启宿主才进页面，刷新页面不够。** 原因见下面「bundle 的 rev」。`index.js`（Host 半）同理。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半。注册 `POST /radar/api` 单条路由，五个命令：`catalog` / `modelInfo` / `select` / `credits` / `creditsRefresh`。 |
| `client.js` | Client 半。`conversation.composer.dock`（order 40）与新会话行的 `conversation.hero.options`（order 40）各挂一颗胶囊 + 各自弹层。 |
| `cordis.patch.yml` | `- insert: [{ id: model-radar, name: dsh-model-radar }]` |
| `verify-host.mjs` | Host 半契约测试（桩驱动，40+ 断言）。 |
| `verify-client.mjs` | Client 半契约测试（自写 hook 桩，真实执行 factory）。 |
| `tests/fmt.mjs` | `fmtCtx` / `effortLabel` 单测（含中英混排回归）。 |
| `tests/catalog.mjs` | 目录并发、TTL 缓存、in-flight 合并、空结果不缓存、容量补全。 |
| `tests/credits.mjs` | 到期文案纯函数：取整方向、当刻金额、窗口总和与单一时刻不得并说。 |
| `build-preview.mjs` | 用**真实组件**渲染 `preview.html`，供截图核验（不是 mock）。 |

数据来源：`llm.listProviders()` / `llm.listModels(provider)`（零模型的提供方直接丢弃，**抛错的提供方不丢，进 `failures` 并在界面出一行警告**）、模型的上下文容量取自 `llm.resolveModelInfo(provider, model).context.contextWindow`、`llm.listModels` 自带的 `badge {text, tone}` 原样透传（只接受字符串文案，message 对象因无 i18n 解析器而被丢弃）、会话事件折叠出当前选择与最近使用。切换走 `sessionController.selectModel`，不可用时降级为 `append('model/selection') + installModelSelection(agentCtx)`。

> **注意 `installModelSelection` 的签名（0.2.2 实测）**：它是**单参数**，职责是挂一个 `agent/pre-step` 监听器，在模型切换时往会话追加一条 `[model changed: ...]` 通知——**它不安装选择 ref**。因此降级路径的 `via` 报 `append+notice`（拿不到 `dsh-agent` 时报 `append-only`），真正的持久化写入是那句 `append`。旧版本里写的 `append+ref` 是错的，已删除。

目录是**打开时才取**、**并发取**、**带 TTL 缓存**的：`listModels` 按 provider 并发（串行时 N 个提供方要 N 倍往返），结果缓存 30s 且 in-flight 请求合并成一次；空结果不进缓存，免得把一次瞬时失败钉住一分钟。容量查询同样按模型并发，且只对「列表里没自带 `contextWindow`」的模型发；同一个缓存周期内不会重复查。胶囊文字只取自 `title`，闭态不发任何请求——挂载即取等于每个会话一次多余往返。

## 契约与坑（改代码前先读）

1. **`const CSS = \`…\`` 模板字符串内部绝不能再出现反引号**，注释里也不行。
   上一版在注释里写了 ``(`.wq12jW_menu`)``，模板被提前终止，`factory` 一执行就抛
   `TypeError: "…" is not a function`。`node --check` 查不出来（截断后依旧语法合法），
   必须真实执行 factory——`verify-client.mjs` 就是干这个的。

2. **`ctx.slots.inject(key, cb)` 的 cb 首参就是 `sessionId`**（`InjectParams<K,H>`）。
   正确写法 `inject: (sessionId) => ({ sessionId })`；不要写成
   `inject: (sessionId) => ({ sessionId, ... })` 里还塞 sessionId 到别处，也不要
   以为首参是 props 对象。

3. **`effortsOf()` 必须同时兼容 `{ id, name, description }` 对象和裸字符串两种形状**。
   宿主不同版本给的 `reasoning` 结构不一样。

4. **弹层里的滚动容器必须有 `min-height: 0`**（`.mr-cols`）。
   grid 子项默认 `min-height: auto`，不给 0 的话内容会把容器撑开、`overflow-y: auto` 永不生效。

5. **`.mr-root` 必须有 `flex: none`。**
   dock 行是 `display:flex; gap:12px; justify-content:center; max-width:100%`，**没有 `flex-wrap`**，
   且已经装了 activity / usage / credits / 上下文仪表。flex 子项默认 `min-width:auto; flex-shrink:1`，
   行满时**被挤到 0 宽的就是最后进来的那个**。这个症状极有欺骗性：Slot 树里 occupant 仍是
   `active: true`，界面上什么都没有（渲染没抛错就不会 abdicate）。

6. **弹层向上开时要用 `bottom` 锚定、不要算 `top`；但必须支持翻折。**
   向上开时首次 `place()` 弹层还没渲染（它要等 `pos` 才出现），用实测高度算 `top` 只能靠猜；
   旧写法猜 360px，真实高度一到就跳一下。锚定「触发器上方 8px 的底边」与高度无关，
   首帧就对，面板变高也是向上长。宽度仍要实测（右对齐触发器，420px 只是上限）。
   **但新会话行的触发器贴着视口顶部（实测约 52px），只向上开会把面板顶出屏幕**——旧代码的
   `Math.max(160, above)` 下限更糟：它强行留 160px 高，其中 116px 在视口外。所以现在按两侧空间
   选择朝向：上方够 `POPOVER_MIN`（160）就向上（`bottom` 锚定），否则向下（`top: rect.bottom + GAP`），
   `maxHeight` 取所选一侧的真实余量、上限仍是 360。`pos` 里 `top` / `bottom` 只会有一个，
   样式两个都传、缺省的自然为 undefined。

7. **高亮滚动不能用 `scrollIntoView()`。**
   它会走遍所有可滚动祖先，包括 document —— 方向键翻到可视区外会把弹层背后的聊天滚动走。
   要用 rect 差值只动 `.mr-models`。注意**不能用 `offsetTop`**：最近的定位祖先是
   `.mr-pop`（`position:fixed`）而不是滚动列，得用 `getBoundingClientRect()` 相减。

8. **`useEfforts` 的 effect 依赖只写 `[provider, model]`。**
   推理阶梯属于**路由**，与当前选中的等级无关。把 `current.reasoningEffort` 也写进依赖，
   每点一次 chip 就会重跑 effect 再取一遍同一个阶梯（每次多余往返）。选中的等级由
   `pickEffort` 本地维护；effect 里用「发请求那一刻的 `effortAtRequest`」做初值，
   因为依赖不含它，闭包里直接读 `current` 会拿到过期值。

9. **`active: true` 不等于「已挂载」。** 想看真实情况，让组件自己量
   `getBoundingClientRect()` 再 POST 回宿主写日志：日志为空 = 根本没被 outlet 渲染；
   有数 = 挂载了但布局塌了。这比猜槽位、猜样式靠谱得多。

10. **bundle 的 rev = `hash(mtimeMs, ctimeMs, size)`。**
    页面启动时从 `window.__DSH_BOOT__` 拿到带 rev 的 URL，改了磁盘文件 rev 会变，
    但**已经打开的页面不会自动换 URL**——必须刷新或重启（HMR watch 只在装了 watch 的包上生效）。

11. **`listModels()` 拿不到 `contextWindow`，容量必须走 `resolveModelInfo()`。**
    核心 llm 在 `listModels` 出口把每个条目**重新构造**成只剩
    `provider / id / name / description / inputModalities`——适配器往里塞的
    `contextWindow` 在这里就被丢了（`dsh-llm` README 也写明 `listModels` 只描述目录）。
    真值在 `llm.resolveModelInfo(provider, model).context.contextWindow`；它是本机同步调用
    （pi-ai 读配置快照、deepseek 读 connection options，都不发网络），但**按模型逐个查**，
    所以必须并发，且只在列表没自带容量时才查。`resolveModelInfo` 抛错（如
    `INVALID_MODEL_CONTEXT`）时**不能让模型消失**：吞掉错误、模型照常可选、只是不带容量。
    这也是「测试全绿但功能是假的」的教训——`verify-*.mjs` 的 mock 直接喂了 `contextWindow`，
    真实宿主却永远不会给。

12. **一个组件、两个 surface，尺寸不能共用一套。**
    新会话行与 composer dock 行是**两条尺寸基线**：dock 行的邻居是 ContextMeter（`padding:1px 8px` over 13px/20px 行盒 → 实高 22px）和 workbuddy credits 读数（`2px 6px` over 12px/18px → 实高 22px）；hero 行的邻居是 workspace chip（`min-height:28px`、13px/20px、weight 500、`padding:0 8px`）。所以同一个 `RadarDock` 用 `surface: 'dock' | 'hero'` 区分，`.mr-pill` 打底 22px、`.mr-pill.mr-hero` 覆盖成 28px。
    别照抄官方 `.wq12jW_trigger` 的 `height:28px`——它不在 dock 行里，抄进 dock 会比两个邻居高出 6px，而且**多余的高度会让 8px 圆角读起来也不对**（视觉上一并错，查起来像两个 bug）。反过来的教训同样成立：一开始按「26px 应该差不多」的目测去调，只会越调越偏；`build-preview.mjs` 会在预览页里用 `getBoundingClientRect()` 把四个盒高和圆角打出来，以那个数为准。

13. **`verify-client.mjs` 里给 `window` 补东西，必须补在传进 `new Function('window', src)` 的那个对象上。**
    组件源码里的 `window.addEventListener` / `window.innerHeight` 读的是那个**形参**，
    后设的 `globalThis.window` 会被它遮蔽。表现是 effect 一执行就
    `window.addEventListener is not a function`，而报错点看起来在测试自己的桩里。

14. **只渲染的测试抓不到 async 回调里的 bug。**
    `loadCredits` 里曾写过 `force === true ? … : …` 而 `force` 从未定义——纯渲染全绿，
    真机一开面板就 rejection。所以 verify-client 现在会：真实执行 effect（`runEffects`）、
    收集 `unhandledRejection`、并在开面板与点刷新后各 `await` 两个宏任务 tick 再断言。
    新加异步路径时顺手把这条当回归探针：故意把变量名改错一次，看测试是否变红。

15. **CSS 模板字符串之外，`client.js` 里也别用模板字符串包三元表达式。**
    `` `${a === b ? '窗口内' : 'x'}` `` 这种嵌套（尤其带中文括号）会让 ego 的
    AsyncFunction 编译路径抛 `SyntaxError: Invalid or unexpected token`，
    且报错位置指向 `new Function` 那一步而不是真凶。多行 tooltip 一律用 `+` 拼接。

16. **locale 插值是单花括号 `{name}`，不是 `{{name}}`。**
    宿主 `translate()` 的实现是 `template.replace(/\{(\w+)\}/g, (m, n) => n in params ? String(params[n]) : m)`。
    写成双花括号不会报错，界面会**原样显示 `{{name}}`**。改文案后必须让 `verify-client.mjs`
    的 locale 桩也走同一套替换逻辑，否则桩会替真实宿主撒谎。

17. **`badge.text` 有两种形状：字符串，或本地化的 message 对象。**
    插件没有 message resolver，只透传字符串那种；对象形状的丢弃而不是 `String()`——
    后者会在界面上渲染出 `[object Object]`。`tone` 是开放字符串，未知值回落到中性色块。

18. **`expiringSoon` 是窗口总和，`nearestExpiryMs` 是最早那一笔——不能说成一件事。**
    快照里 16 个包的到期时刻各不相同，把总和挂在最早那个时刻上，等于宣称 1904 分在
    11-11 23:37 全没，实际只掉 404。当刻金额要靠 `expiringAtInstant()` 按
    `expiresAtMs` **精确相等**另算；没有包级明细就不提金额。**测试 fixture 必须带真实
    `packages` 明细**——`packages: []` 让这个 bug 完全隐身，`verify-client.mjs` 曾经
    就是这么漏掉的。

19. **到期倒计时只能向下取整。**
    `Math.ceil` 把 27.8h 和 30.7h 都显示成「2 天」，让紧的时间看起来还有富余。
    用 `Math.floor((diff + 60000) / DAY_MS)`，那 60 秒是消掉计算与渲染之间的毫秒差。

20. **快照是外部文件，每个数组读入都要当成不可信。**
    `latest.json` 可能被旧版本脚本写、被手工改、或被抓到写了一半。`creditsView`
    曾直接写 `(entry.accounts || []).slice(0, 3).map(...)`——`accounts` 不是数组时
    抛 `map is not a function`，元素是 `null` 时抛 `Cannot read properties of null`。
    **渲染期抛错会掀掉整个面板**，比少显示一个数字严重得多。现在一律先
    `Array.isArray()`、再逐元素判 `typeof row === 'object'`。`tests/credits.mjs`
    里有 9 条畸形快照断言当回归探针——删掉防护它们会立刻变红。

21. **粒子要不要动，是插件自己的开关，不是 `prefers-reduced-motion`。**
    原来这里有一条 `@media (prefers-reduced-motion:reduce){ .mr-rail .p{animation:none} }`。
    Windows 的「系统属性 → 高级 → 性能 → 调整为最佳性能」会把
    `SPI_GETCLIENTAREAANIMATION` 读成 0，Chromium 据此把 `prefers-reduced-motion` 判为
    `reduce`（`ui/gfx/animation/animation_win.cc`：`prefers_reduced_motion_ = !win_anim_enabled`），
    于是**整机所有页面**的粒子一起冻结——档位越高粒子越多越短（5→20 颗、2.9s→2.0s）的差异
    全被遮蔽，看起来像「粒子根本不响应档位」。这条媒体查询用户无法关掉，所以不能留。
    现在改成 `.mr-rail.still .p{animation:none}` + 滑条行尾一颗开关按钮，状态存
    `localStorage['dsh-model-radar:motion']`。**前端拿不到 `cordis.patch.yml` 的 `config`**
    （后端 `apply(ctx, config)` 才有第二参，前端 `apply(ctx)` 只有一个），所以只能走 localStorage。
    `verify-client.mjs` 用 `/@media[^{]*prefers-reduced-motion/` 守回归——注意只匹配 at-rule，
    本段注释里提到这个词不算回归。

22. **粒子要能被眼睛读到，光「在动」不算。**
    第一版是 1–2px 的颗粒、统一 16px / 2.9s 上升、横向全挤在 ±2px。换算下来
    **5px/s，60 帧下每帧位移不到 0.1px**——低于人眼判定「在移动」的阈值，所以整体
    看起来是静止噪点而不是流沙。同时所有颗粒同向同速同行程，只能读成「一张纸往上滑」。
    现在的口径：三层景深（近 1.9–3.1px / 中 1.2–2.0px / 远 0.8–1.4px），
    行程 26 / 17 / 11px，摆幅 4.0 / 2.6 / 1.5px，速度覆盖 **4.2–36.5px/s**；
    档位同时把 `--dur` 乘 0.095×rung 的整体倍数（顶档 0.62x）。颗粒数 8→32。
    `verify-client.mjs` 加了两条硬断言守回归：`--run` 至少两种取值（没有景深就报错）、
    最慢颗粒不得低于 3px/s。

    **方向必须沿着它所在的那根条（2026-11-10 改）。** 第一版是竖直往上飘，
    但它是挂在 effort 填充条里的——填充条随档位**从左往右**长，颗粒却往上跑，
    运动方向垂直于被测量的东西，读起来像条子里刮沙尘暴而不是流动。
    现在 `--run` 是横向行程（26/17/11px），终点写成
    `translate(calc(-50% + var(--run)),-50%)`——**加号是关键**，减号就是回到旧方向；
    上下摆动改由 `--bob` 承担（`translate:0 ±bob`），景深靠摆动幅度区分。
    起点 x 收到 3–85%、y 放开到 22–78%：横向走完 26px 后仍在条内，不会刚出场就被裁掉。
    `verify-client.mjs` 用两条正则守方向（必须含 `+ var(--run)`、不得含 `- var(--run)`），
    另一条守 bob 轨道必须是纵向。

23. **档位要跟手，不能等宿主回话。**
    两个 surface 的 `pickEffort` 原先都是先 `await api('select')`，拿到结果才
    `setEfforts`。宿主在冷通道上往返 1–2 秒，于是松开滑块后旋钮停留在**旧档位**，
    同时因为写操作会把 `busy` 置 true，整根滑轨一起变灰变惰性——看起来就是「卡住了」。
    现在改成**乐观更新**：松手立刻 `setEfforts`，再发请求；失败时按值回滚
    （`e2.currentEffort === effort` 才回滚，避免旧的失败把新的成功撤掉）。
    **`pickEffort` 不再碰 `busy`**——拉滑轨不是切模型，不该让整个面板变灰。
    回滚不能引入新的 `useRef`：`RadarDock` 的 hook 顺序被
    `verify-client.mjs` 按下标播种，多一个 hook 会错位。
    `verify-client.mjs` 断言两个 surface 都存在该函数、且`setEfforts` 出现在
    `await api('select'` **之前**、函数体内不得出现 `setBusy(true)`。

## 积分到期徽标（credits 命令）

选模型时想知道「这个渠道还有多少分快过期」。徽标挂在**提供方行**上（不在模型行），页脚显示快照年龄 + 一颗「刷新」。

**数据源是本地快照文件，不是上游。** `~/.dsh/credits-expiry/latest.json`，由
`E:\deepseek-workspace\credits-expiry-report\report.mjs --snapshot=<该文件>` 生成（**3 天窗口**、三家齐全、包级到期）。
**这一步没有人自动帮你做**——没有计划任务、没有 schedule，快照只会在有人手动跑脚本时更新。
所以页面上的「快照 Nh」不是装饰，它就是这个数字的可信边界。
开面板只做一次 `stat` + 读一个小 JSON，读结果缓存 15s（`CREDITS_READ_TTL_MS`）。

**雷达本体零插件依赖**：全部 import 只有 `node:*` 五个内置模块加 React，不引用任何
`dsh-connect-*`，所以插件升级、改名、卸载都碰不到它——它只读那个 JSON。
依赖在**生成侧**：`credits-expiry-report/lib/workbuddy.mjs` 会去 `~/.dsh/profiles/desktop/node_modules/dsh-connect-workbuddy/lib`
里找 `host-heartbeat-*.js` 动态 import（TRAE 与 Qoder 那两份都自己重写了协议，不进插件目录）。
插件一重新构建，那个文件名里的哈希段就变；`report.mjs` 现在用 `isolate()` 把每家的失败收敛成
一条错误行，workbuddy 挂了只丢它自己，不再连坐整份报告和另外两家。

为什么不去问那三个插件、也不直连上游：

- 插件的积分**只在内存里**，不落盘。WorkBuddy 的 `?detail=fast` 干脆不带 `credits` 字段；TRAE 4.17.0 只给 **24 小时 / 3 天 / 7 天三档**（`lib/index.js:9310-9312` 的 `within24h` / `within3d` / `within7d`，由 `expiringWithin(accounts, nowMs, N*DAY)` 算），它的三档里没有「本快照的窗口」这一档可借（脚本窗口是参数，随时可能被 `--window-days` 改掉）；Qoder 走 `usage.badge`，`expiredTime` 实测是空串。
- 两家的卡片自己就在 **60 秒轮询**上游（`POLL_INTERVAL_MS = 6e4`），一次全量 = 选中号 2 次 + 池内每号各 1 对。雷达再挂一个逐号消费者是第三种流量。本机已有实锤：`.workbuddy-pool.global.json` 里两个号被上游标 `account-restricted`（`code:11140 账号存在异常行为，已被限制使用`）。

所以「刷新」按钮是**唯一**能打上游的路径，且只有点击才 spawn 一次脚本。spawn 失败（受限宿主 / 退出码非 0）时返回 `manual` 字段——一条可直接复制的 `node … --snapshot=…` 命令，徽标降级为「快照 N 前」而不是报错消失。

三种徽标形态，**干净渠道不显示 0**：`1258·3d`（琥珀，窗口内即将过期）、`!N`（红，已过期但仍有余额）、`?N`（灰底主文字色，只有账号读不到——信息性，不是损失告警）。

### 窗口是 3 天，而且插件自己重算

面板说话的窗口由 `DISPLAY_WINDOW_DAYS = 3` 一个常量决定（脚本侧 `report.mjs` 的默认
`windowDays` 也是 3）。**两边都改过，但插件不能信任快照里的 `expiringSoon`**：盘上那份
可能是更早用 15 天窗口写的，或者干脆是别人手改的。所以 `expiringWithin()` 每次读盘后
**按包级 `expiresAtMs` 重算一遍**，重算结果优先；只有包级明细缺失（某账号 `packages: []`）
时才回落到快照里存的数——那条降级路径就是老代码一直用的路径，已知不会说谎。

两种「没有包」必须分开：**某账号有 `packages: []`** = 上游没给明细，未知，返回 `null` 让上层
保守处理；**整个 provider 的 `accounts: []`** = 确实没有账号，已知的空，返回 `{soon:0, nearest:null}`。
把两者混成一个零，要么凭空造数，要么把陈旧总额放回来。

超过窗口的行**整条不显示**，不是改成小字重述——在一个「3 天内」的标题下写一个 14 天后
才到期的金额，是把同一个错误降一级重犯。

### 两个数字不能并成一句话

`expiringSoon` 是**整个窗口**（现在 3 天）内所有包的总和；`nearestExpiryMs` 只是其中**最早那一个包**的时刻。把它们拼成「1904 分将在 11-11 23:37 过期」是错的——那一刻只到期 404 分，剩 1500 分还有两周缓冲，却被说成马上没了。

正确写法把两者分开：

```
595 分将在 3 天内陆续过期，最早 11-11 23:30（剩 14 小时）到期 195 分
182****5914：窗口内 595 分，最早 11-11 23:30 到期 195 分
```

（这组数字是 2026-11-11 09:08 真实快照的实测输出。）

当刻金额由 `expiringAtInstant()` 只累加 `expiresAtMs` **精确等于**该时刻的包算出。快照没有包级明细时返回 `null`，句子就**不提金额**（只说「最早 …」），绝不拿窗口总和顶替。

**到期警告的取整方向只能是向下。** `daysUntil` 用 `Math.floor((diff + 60000) / DAY_MS)`：30.7 小时是「1 天」不是「2 天」。往上凑会让本来就紧的时间看起来还有富余，这是到期提示唯一不能犯的错。旧值 `Math.ceil` 把 27.8h 和 30.7h 一起显示成「2 天」，方向反了。+60 秒是消掉「算完到画上去」之间的毫秒差，避免正好 3 天整被算成 2 天。

## 视觉口径

字体与主题全部对齐官方，只在 `--dsw-alias-*` / `--dsw-radius-*` / `--dsw-elevation-*` / `--ds-font-family-code` 范围内取值，不硬编码任何颜色或阴影（浅色/深色都要能用）：

- 胶囊：几何照抄**当前行**的原生成员，不是照抄官方 `.wq12jW_trigger`——它在输入栏里、不在 dock 行里。dock 行取 22px（`padding:0 4px 0 8px`、13px/20px、`radius-sm`、无边框）；新会话行取 28px（`padding:0 8px`、13px/20px、weight 500、`radius-sm`）。hover/展开用 `--dsw-alias-interactive-bg-hover`，focus 用 `--dsw-focus-ring-*`。**文字只留「模型雷达」**：同一行里官方触发器已经在报当前模型与推理等级，胶囊再抄一遍只会把行挤满（实测带路由时 318px，占 743px 行近一半）；当前路由放在 `title` 里。
- 弹层：照抄官方 `.wq12jW_menu`——`z-index:1100`、宽 420 / 高 360 上限、内缩 4px、**无边框**，阴影用 `--dsw-elevation-prominent`（其 `.5px` 描边色钉成 `--dsw-alias-border-l1`，与官方菜单一致），表面用 `--dsw-specific-menu` + `--dsw-menu-backdrop-filter`。
- 等宽字体用 **`--ds-font-family-code`**（`--dsw-font-mono` 这名字官方并不存在）。
- 模型行 34px 高、`radius-md`、13px/18px，与官方 `.wq12jW_option` 同档。
- **弱色一律用 `--dsw-alias-label-secondary`（4.70:1），不用 caption/tertiary（3.61:1）**：分组标题、计数、页脚、空态都在 11–12px，落在 4.5:1 门槛之下会真的看不清。层级靠字号与字重区分，不靠继续压暗。

## 验证

```powershell
node --check client.js ; node --check index.js
node tests/fmt.mjs       # fmtCtx / effortLabel 的纯函数单测
node tests/catalog.mjs   # 并发取目录 + TTL 缓存 + in-flight 合并 + 空结果不缓存 + 容量补全
node tests/credits.mjs   # 到期文案：取整方向 + 当刻金额 + 窗口总和不得与单一时刻并说
# verify-client.mjs 另断言：粒子开关存在、默认开、无 prefers-reduced-motion 媒体查询
node verify-client.mjs   # 必须真实执行 factory，能抓出坑 1；同时断言双槽注册与两条基线
node verify-host.mjs     # 路由 / fence / catalog / modelInfo / select 全链路
node build-preview.mjs   # 然后用 oil_ui_shoot 截 preview.html 看视觉
```

`preview.html` 用的是 `client.js` 里的**真 CSS 字符串**和**真实注册对象**展开出来的元素树，
所以它反映的是组件真实输出——但它毕竟不是宿主页面，`dock` 行里的邻居、真实主题变量
仍需在 GUI 里肉眼确认。预览页的 `:root` 必须把插件引用的每个 token 都定义出来（当前 23 个）：
少定义一个 `--dsw-elevation-prominent` 或 `--dsw-specific-menu`，弹层就会糊进输入框卡片，
那是预览的缺陷、不是插件的。
