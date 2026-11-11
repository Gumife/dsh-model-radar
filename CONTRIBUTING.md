# 参与改进

这是个人自用项目（见 README 顶部说明），不是有支持义务的产品。改代码、提 Issue、发 Pull Request 都欢迎，但我**不承诺响应时间**，也不承诺接受改动——合并与否取决于它对我自己有没有用。真要改，Fork 走比 PR 更省事。

## 环境

- Node.js >= 20
- DeepSeek Harness（`engines.dsh` 声明了兼容区间，宿主会据此拦截不兼容的安装，不会静默失败）

## 改完怎么验

```bash
node --check index.js && node --check client.js
node tests/fmt.mjs
node tests/catalog.mjs
node tests/credits.mjs
node verify-client.mjs
node verify-host.mjs
```

全部脚本使用桩驱动，不需要登录态，也不碰真实 profile。

`verify-client.mjs` 会**真实执行** client 的工厂函数——这是唯一能抓到「CSS 模板里混进反引号」这类加载期语法错误的办法（`node --check` 看不出来），所以不要跳过它。

## 提交约定

- 一个改动一个 commit，提交信息说清**为什么改**，不只是改了什么
- 不提交 `.bak-*` 备份文件（`.gitignore` 已排除）；改之前的样子 `git diff` 就能看，不需要手工备份
- `cordis.patch.yml` 和 profile 里的安装状态不建议手改，走 `plugin_manager` 的 install/remove 动作

## 报问题

在 Issues 里写清楚：DSH 版本、复现步骤、期望与实际。有宿主日志更好。
