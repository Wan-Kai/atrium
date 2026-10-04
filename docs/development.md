# 开发环境与流程

> 2026-10-04 定，M1.1 搭好骨架时按实际情况补全。

## 环境与版本

| 项 | 要求 | 说明 |
|---|---|---|
| 系统 | macOS 13 及以上 | v0.1 只做 macOS；13.0 是 Electron 44 的最低要求 |
| Node.js | ≥ 22.19 | pi 的要求；开发和测试里都要跑 pi |
| pnpm | 12.9.1 | 根 `package.json` 的 `packageManager` 字段固定 |
| Electron | 44.5.1（自带 Node 24.21、Chromium 152） | 宿主跑在它自带的 Node 里（`utilityProcess`） |
| TypeScript | 7.0.2 | 原生实现，没有 JS 编译 API，依赖它的工具（如 Stryker 的 tsconfig 改写）要绕开 |
| git | ≥ 2.38 | 合并状态的判定要用 `git merge-tree --write-tree` |
| pi | 最低 1.0.1 | [pi-internals.md](research/pi-internals.md) 基于 1.0.1；M1.1 时本机装的是 1.0.2。pi 升级时先跑契约测试（`pnpm test:pi`） |

依赖一律锁定精确版本，升级单独提交（[coding-standards.md](architecture/coding-standards.md#依赖)）。

## 分支

- 每个里程碑开一个分支，如 `m1.1-skeleton`；完成并通过该里程碑的完成标准后，在本地合并回 `main`。
- 合并前可以用 `/code-review` 审查整个分支。
- 只在明确要求时推送。
- 原型在 `prototype/ui` 分支，不合并进 `main`。

## 提交

- 作者 `Ktoon <daodi154@gmail.com>`。
- 提交信息用英文、祈使句；正文说明改了什么、为什么。
- 每个提交都能通过 `pnpm check` 和第 1、2 层测试（lefthook 在提交和推送前检查）。

## 第一次准备

```sh
pnpm install                                                  # postinstall 会下载 Electron 的二进制
pnpm exec playwright install chromium chromium-headless-shell # 浏览器组件测试和端到端测试用
```

本机需要装好 pi（第 3 层契约测试会真的运行它）。

## 命令

| 命令 | 内容 |
|---|---|
| `pnpm dev` | 构建宿主和 Electron 主进程，启动 Vite（界面热更新，端口 5791，可用 `ATRIUM_DEV_PORT` 改）和 Electron。数据写在真实的 `~/.atrium`。改了宿主或主进程后重启它 |
| `pnpm build` | 构建宿主（单文件 `packages/host/dist/entry.cjs`）、界面、Electron 主进程和预加载脚本 |
| `node packages/host/dist/entry.cjs` | 不经 Electron 单独运行宿主；第一行输出地址和 token（只打到终端，不进日志） |
| `pnpm trace <trace id>` | 按 trace id 打印一条链路的 span 树和日志 |
| `pnpm check` | 格式、代码检查（含 JSDoc）、类型检查、knip |

测试命令见 [testing.md · 命令](architecture/testing.md#命令)。
