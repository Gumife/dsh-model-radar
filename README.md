# 模型雷达（dsh-model-radar）

> **这是个人自用项目，不是通用产品。**
> 它是我自己日常在用的工具，开源只是为了代码可读、可改、可搬零件。
> 接口随我自己的需要变动，**不承诺向后兼容**；遇到问题欢迎提 Issue，但**不承诺响应时间**。
> 你要用，请自己读代码、自己承担后果。

在输入框下方挂一个**旁路入口**：点开是「提供方在左、模型向右展开」的目录面板，支持搜索、最近使用、推理等级切换。

它**不接管**输入框工具栏里的官方模型选择器——官方那颗按钮始终在座、始终可用，本插件只是同一行里多出来的一颗胶囊。

两个槽位都要挂（`conversation.composer.dock` 与 `conversation.hero.options`）：宿主在**新会话空态**渲染的是 hero 行，不是 composer dock 行，只挂一个会有一段时间看不见入口。两槽互斥，不会同时出现。

## 安装

需要 DeepSeek Harness，版本区间由 `package.json` 的 `engines.dsh` 声明——不满足时宿主会直接拦下并说明原因。

**方式一：直接从 GitHub 安装**（不用先克隆）

```powershell
plugin_manager install_bundle(target='github:Gumife/dsh-model-radar')
```

**方式二：克隆到本地，再指向目录**

```powershell
git clone https://github.com/Gumife/dsh-model-radar.git
plugin_manager install_bundle(target='<你的克隆路径>/dsh-model-radar')
```

不要手改 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 目录跑 pnpm。卸载走 `plugin_manager` 的 `remove_bundle`，别手工删目录。

`github:` 源安装锁定当时的 HEAD commit，升级要重新执行一次安装；克隆 + 本地目录安装则是改完重启即生效。

**改完 `client.js` 或 `index.js` 必须整进程重启宿主，刷新页面不够。**

## 用法

点胶囊开面板 → 搜索或按提供方浏览 → 点一行切换模型 → 滑条调推理等级。

「最近使用」与会话当前选择从会话事件里折叠得出，不额外存盘。推理等级**松手即生效**（乐观更新），不等宿主回话。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半。注册 `POST /radar/api`，五个命令：`catalog` / `modelInfo` / `select` / `credits` / `creditsRefresh`。 |
| `client.js` | Client 半。两个槽位各挂一颗胶囊 + 各自弹层。 |
| `cordis.patch.yml` | 挂载声明（`name` 必须等于包名）。 |
| `verify-host.mjs` | Host 半契约测试，桩驱动。 |
| `verify-client.mjs` | Client 半契约测试，**真实执行** factory。 |
| `tests/*.mjs` | 纯函数单测（格式化、目录缓存、到期文案）。 |
| `build-preview.mjs` | 用真实组件渲染 `preview.html`，供截图核验。 |

数据全部来自宿主 API：`llm.listProviders` / `llm.listModels` / `llm.resolveModelInfo` / `sessionController.selectModel`。**零第三方依赖**，不 import 任何 `dsh-connect-*`，所以别的插件升降级不会影响到它。

## 积分到期徽标（可选）

选模型时能看到「这个渠道还有多少分快过期」，徽标挂在**提供方行**上。

数据来自本地快照 `~/.dsh/credits-expiry/latest.json`，由外部脚本写入，**脚本不在本仓库内**。没有这个文件，徽标区就是空的，雷达其余功能完全不受影响。页脚那个「快照 Nh」不是装饰——它就是这组数字的可信边界。

窗口 3 天。徽标三种形态：`1258·3d`（窗口内将过期）、`!N`（已过期但仍有余额）、`?N`（账号读不到）。干净渠道不显示 0。

## 验证

```powershell
node --check index.js ; node --check client.js
node tests/fmt.mjs
node tests/catalog.mjs
node tests/credits.mjs
node verify-client.mjs
node verify-host.mjs
node build-preview.mjs   # 生成 preview.html 供肉眼核验
```

全部桩驱动，不需要登录态，也不碰真实 profile。`verify-client.mjs` 会**真实执行** factory——`node --check` 抓不到加载期错误（比如 CSS 模板里混进反引号），靠它抓。

`preview.html` 用组件真实输出渲染，但毕竟不是宿主页面：dock 行里的邻居与真实主题变量还得在 GUI 里看一眼。
