# dsh-llm-grok — 实验性非官方插件

这是一个面向已发布 `@deepseek-ai/dsh` Web profile 的实验性、非官方插件。用户可以用 SuperGrok 或 X Premium+ 账号登录并调用 Grok 模型，不需要 xAI Console API Key。

本插件由独立维护者维护，与 DeepSeek、deepseek-ai、xAI 或上游 DeepSeek Harness 项目没有隶属、背书或发行关系。

本插件占用独立路由 `grok`，不替换内置的 `xai` API Key 卡片。

## 兼容性和状态

已测试的宿主版本是 **精确的** `@deepseek-ai/dsh@0.1.0-rc.7` 和 `@deepseek-ai/cordis@4.0.1`。package 声明的 optional 宿主 peer 也全部是精确版本：dsh-llm、dsh-settings、dsh-timeout 为 `0.1.0-rc.7`，schemastery 为 `3.18.1`，React 为 `18.3.1`。这里的 optional 表示由 dsh 宿主注入，npm 不会安装重复副本，不表示允许任意版本。缺少或不同版本的 peer 都超出已测试契约；插件自身不提供兼容保证。维护者必须先测试并更新精确 pin，才能采用其他宿主版本。

上游 dsh Web profile 仍是 **Developer Preview**。插件加载器、patch 格式、UI 模块和 provider API 都可能在没有兼容承诺的情况下变化。每次宿主升级后都必须重新测试，本插件仍属于实验性软件。

## 安装

在 `deepseek-rs` 仓库中：

```sh
cd ~/Github/deepseek-rs
pnpm --dir plugins/dsh-llm-grok pack --pack-destination "$HOME/.dsh/profiles/web"
pnpm exec dsh plugin --profile web add "$HOME/.dsh/profiles/web/dsh-llm-grok-0.1.0.tgz"
pnpm exec dsh --version  # 必须输出 0.1.0-rc.7
```

不要用 `link:`。Node 会按文件的真实路径解析 ESM。符号链接指回仓库后，找不到 `.app` 里的 `@deepseek-ai/schemastery`。打包成 tarball 会把插件拷进 profile，Node 再从 `~/.dsh/profiles/node_modules` 找到宿主包。

安装后重启 `dsh web` 或 **DeepSeek RS — Unofficial DSH wrapper** 应用。客户端模块只在进程启动时加载。`src/client.js` 必须是经典脚本工厂：执行时调用 `window.__ModuleLoader__.load({ id: 'dsh-llm-grok', factory })`。ESM 的 `import`/`export` 文件会加载，但不会注册。

同一版本号 `0.1.0` 再装一次时，pnpm 可能继续用旧文件。先卸载再安装：

```sh
pnpm exec dsh plugin --profile web remove dsh-llm-grok
pnpm exec dsh plugin --profile web add "$HOME/.dsh/profiles/web/dsh-llm-grok-0.1.0.tgz"
```

## 使用

1. 打开 **设置 → Grok**。
2. 点击 **使用 Grok 账号登录**。系统浏览器会打开 `auth.x.ai`。
3. 在页面上确认设备码。
4. **新建会话**，在模型列表中选择 `Grok 4.6` 或 `Grok 4.5`。

本机进程需要访问 `https://auth.x.ai` 和 `https://cli-chat-proxy.grok.com`。浏览器能打开但登录失败时，给启动 `dsh` 的环境设置 `HTTPS_PROXY`。

若本机已通过上游 Grok CLI 登录，插件会复用 `~/.grok/auth.json`，退出登录不会删除该文件。本插件自己的 token 写在 `$DSH_HOME/grok-oauth.json`（权限 `0600`）。

## 升级和回退

只有在 wrapper 采用并测试新的 dsh 精确 pin 后，才升级插件。重新打包插件；如果宿主契约变化，同时更新 dsh/Cordis 的精确 peer pin；从 profile 删除旧副本，再安装新的 tarball。保留旧 tarball 和旧 `.app`。

回退时，先卸载 `dsh-llm-grok`，再安装归档的旧 tarball，并重启 dsh 或 wrapper 应用。如果宿主也已升级，启动 app 前先恢复旧的 dsh 精确版本和匹配的 lockfile。

发布 workflow 的目标是 macOS arm64；目前不声称已有签名的 wrapper artifact。没有签名凭据时，`pnpm tauri build --bundles app` 只是用于开发和测试的本地未签名构建。维护者配置 Apple 签名和公证凭据后，workflow 才会按目标完成签名、公证、stapling，并计划发布 `DeepSeek-RS-<version>-aarch64-apple-darwin-ARM64.app.zip`。插件 tarball 独立于 app，并包含自己的许可证和 notices。

## 卸载

```sh
pnpm exec dsh plugin --profile web remove dsh-llm-grok
```

卸载后须重启。

## 测试

```sh
pnpm --dir plugins/dsh-llm-grok run quality
```

## 许可证

MIT，见 package 内的 [`LICENSE`](LICENSE)。tarball 同时包含 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)，记录精确的宿主 peer 版本和许可证元数据。插件不会自动打进默认 app runtime。
