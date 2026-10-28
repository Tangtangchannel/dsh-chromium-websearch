# dsh-chromium-websearch

给 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh-base) 用的、真正开浏览器去搜、去抓的 `web_search` / `web_fetch` 后端。

[English](README.md) · 中文

装完就能用：本机没有 Chromium 时它会自己下一次 Chrome for Testing，之后一直复用。不需要装依赖，不会跑 postinstall，也不需要你手动装浏览器。

## 它解决什么

Harness 自带的搜索走 HTTP API，自带的抓取就是个 HTTP 客户端。两者会被同样的东西拦住：机器人校验、纯 JS 渲染的页面、登录拦页。这个插件改成驱动一个真实的有头 Chromium（CDP 协议），模型看到的就是人打开页面看到的内容。

它不改工具、不改提示词、不改任何面向模型的文案，只注册两个 `ctx.web` provider，再把 `web` 服务指过去。

- `web_search` → 在真实标签页里打开 Bing / DuckDuckGo / 百度，从 DOM 里取结果链接，还原跳转地址，返回 `{ sources: [{ title, url, snippet }] }`。
- `web_fetch` → 在真实标签页里打开目标页，等掉常见的机器人拦截页，去掉 script/style/svg/iframe，返回干净的 HTML 或纯文本。

## 安装

作为 profile bundle 安装：

```
plugin_manager install_bundle  target: dsh-chromium-websearch
```

本地开发时指向检出目录：

```
plugin_manager install_bundle  target: /absolute/path/to/dsh-chromium-websearch
```

不安装任何依赖：只 import `node:` 内置模块和自己的文件。

### 浏览器从哪来

优先**用**已有的浏览器，顺序是：`chromePath` → `DSH_BROWSER_CHROME` / `CHROME_PATH` → Playwright 的构建缓存 → 常见安装位置里的 Chrome for Testing / Chrome / Chromium / Edge / Brave。

都找不到时，自动下载 stable 版 Chrome for Testing 到 `~/.dsh/browser-web/chromium`，写一个 `current.json` 标记，之后直接用。首次需要联网，占约 200 MB 磁盘。想彻底离线，把 `autoProvision` 设为 `false`，自己准备浏览器。

## 三种模式

| 模式 | 干什么用 |
| --- | --- |
| `anonymous`（默认） | 一次性 profile，用完即弃。普通搜索/抓取用这个。 |
| `signed-in` | 常驻 profile，第一次会开登录窗口让你自己登；会话 cookie 会恢复。 |
| `personal` | 直接用一个已存在的 Chrome profile 目录（`personalProfileDir`），插件不写任何标记进去。 |

## 主要配置

全部可选，默认值够用。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `anonymous` | 见上表。 |
| `chromePath` | 自动探测 | 也读 `DSH_BROWSER_CHROME` / `CHROME_PATH`。 |
| `autoProvision` | `true` | 找不到浏览器时自动下载。 |
| `provisionDir` | `~/.dsh/browser-web/chromium` | 下载的浏览器放哪。 |
| `indexUrl` | 官方索引 | 换镜像或离线副本时用。 |
| `headless` | `false` | 无窗口运行；有些拦截页只有有头模式能过。 |
| `engines` | `bing`、`duckduckgo`、`baidu` | 优先顺序。 |
| `maxResults` | `8` | 单次搜索上限。 |
| `fetchTimeoutMs` | `45000` | 抓取总预算。 |
| `bodyFormat` | `html` | `html` / `text` / `auto`。 |
| `journal` | `true` | 追加 JSONL 轨迹（不含查询词、URL、cookies）。 |

完整字段见[英文 README](README.md#configuration)。

## 测试

```
npm test                     # 离线：单元 + 自动下载相关用例，不需要浏览器和网络
node scripts/accept.mjs      # 全量：静态检查 + 单元 + 引擎夹具 + 真实搜索抓取
```

`npm test` 是克隆下来直接能跑的命令，也是发布前的门禁。

## 许可

GPL-3.0-or-later，见 [LICENSE](LICENSE)。

```
Copyright (C) 2026 大肥鱼 (DeepSeek), amecandy
```

## 作者

- 大肥鱼（DeepSeek）
- amecandy
