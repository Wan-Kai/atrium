# 开发环境与流程

> 2026-10-04 定。M1.1 搭好骨架后补上实际的安装和启动步骤。

## 环境与版本

| 项 | 要求 | 说明 |
|---|---|---|
| 系统 | macOS | v0.1 只做 macOS；最低版本以所用 Electron 版本支持的为准，M1.1 固定 Electron 时记录 |
| Node.js | ≥ 22.19 | pi 的要求；开发和测试里都要跑 pi |
| pnpm | 12.x | 根 `package.json` 的 `packageManager` 字段固定具体版本 |
| Electron | M1.1 时的最新稳定版（调研时 44.x） | 宿主跑在它自带的 Node 里（`utilityProcess`） |
| TypeScript | 7.x | |
| git | ≥ 2.38 | 合并状态的判定要用 `git merge-tree --write-tree` |
| pi | 最低 1.0.1 | [pi-internals.md](research/pi-internals.md) 基于 1.0.1；第 3 层契约测试记录"测试时用的版本"，pi 升级时先跑契约测试 |

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

## 命令

测试相关的命令见 [testing.md · 命令](architecture/testing.md#命令)。M1.1 后在这里补上 `pnpm dev`、构建、录制夹具等命令。
