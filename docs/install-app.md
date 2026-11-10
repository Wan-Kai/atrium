# 把新包装到"应用程序"

> 2026-11-05 定，起因是当天两次换装事故：第一次脚本被 Atrium 退出时一起杀掉，第二次用 `launchctl submit` 提交的作业退出就重启，把 Atrium 连装了十几次。做法固化成 [scripts/install-app.sh](../scripts/install-app.sh)。开发流程里在哪一步用，见 [development.md · 标准开发流程](development.md#标准开发流程) 第 7 步。

用户验收后要装上试用、或自用要用上新包时，走这里。只替换 `/Applications/Atrium.app`，不碰 `~/.atrium`。

## 一条命令

```sh
ATRIUM_CODESIGN_IDENTITY="Apple Development: …" pnpm package   # 不设就签 ad-hoc
sh scripts/install-app.sh                                       # 可选 --source <Atrium.app>、--wait <秒>
tail -f ~/Library/Logs/Atrium/install-app.log
```

直接运行时它只做一件事：写一个一次性 launchd 作业（`~/Library/LaunchAgents/dev.atrium.install-app.plist`，`RunAtLoad`、**不设** `KeepAlive`）并 `bootstrap`，打印会中断几个 pi 会话，然后返回。真正的换装由那个作业做：

1. 删掉自己的 plist，再等 12 秒；
2. `quit` Atrium，等主进程消失，超时依次 `TERM`、`KILL`，还是不走就放弃、什么都不替换；
3. `tccutil reset SystemPolicyDocumentsFolder dev.atrium.app`；
4. 旧包 `mv` 成 `/Applications/Atrium.app.bak-<时间戳>`，`ditto` 新包进来，去掉隔离标记，`codesign --verify --deep --strict` 验签，`open` 重开；
5. 拷贝失败时把备份 `mv` 回去并重开。

装完跑一阵 `pnpm errors`，逐条查标 `new` 的新错误签名（[testing.md · 运行时监控](architecture/testing.md#运行时监控)）。

## 为什么非得这样

- **不能从 Atrium 里的 pi 起脚本**。Atrium 退出时按父进程关系连同进程组收掉后代（`packages/pi` 退出 pi 时杀进程树就是这么做的），`nohup … &` 一样被杀。2026-11-05 第一次尝试的日志停在 `quitting Atrium`，`/Applications/Atrium.app` 没被换。
- **不能用 `launchctl submit`**。它提交的作业是常驻的，进程一退出 launchd 就重新拉起；脚本以 `open` 结尾、正常退出，于是变成"退出 → 替换 → 重开 → 再退出"的循环。2026-11-05 连装十几次，同一天 16:26 那次（add-google-logo 的旁路脚本，日志 `/tmp/atrium-replace.log` 每 50 秒一轮）是同一个坑。
- **一次性作业**：LaunchAgent + `RunAtLoad` + 不设 `KeepAlive` = 每次加载只跑一次。两道保险兜住意外重跑：脚本一开始就删掉 plist；`~/Library/Logs/Atrium/install-app.last` 记着上次运行的时间，10 分钟内又被拉起就只记一行 `ABORT` 后退出。
- **12 秒的等待**（2026-11-05 用户定，原先试过 45 秒）：脚本一退 Atrium，发起这次换装的那个 pi 会话就断了。等一会儿是为了让它把回复说完、用户看到"要重开"，不至于话说到一半消失。

## 事后核对

```sh
grep -E "replaced|relaunched|restoring|ABORT" ~/Library/Logs/Atrium/install-app.log | tail -3
codesign -d -r- /Applications/Atrium.app | grep designated
launchctl print "gui/$(id -u)/dev.atrium.install-app"   # 期望：找不到该作业
ls -d /Applications/Atrium.app.bak-*                    # 备份，确认没问题后删掉
```

成功的标志：日志里 `replaced; backup=…` 后面跟着 `relaunched`；requirement 是 `identifier "dev.atrium.app"` 加证书（ad-hoc 签的是 `cdhash`，每打一次包就变）。

## 回滚

先退掉 Atrium，再把备份换回来：

```sh
mv /Applications/Atrium.app.bak-<时间戳> /Applications/Atrium.app
```

## 签名与权限

- 设了 `ATRIUM_CODESIGN_IDENTITY`（`security find-identity -v -p codesigning` 里的一条）就用那张证书签，designated requirement 是「bundle id + 证书」，一次授权跨重装有效；不设是 ad-hoc，requirement 是二进制的 cdhash，每次换装 macOS 都当成另一个 app，重新问"文稿"等受保护目录，不点允许时 `~/Documents` 下的 git、pi、读文件都会挂住（2026-10-24 查明，见 [self-use.md · 问题](research/self-use.md#问题)）。
- 换签名后旧记录还在，脚本里的 `tccutil reset` 让它重新问一次。
- 打包的细节（产物位置、应用目录内容、都不公证）见 [development.md · 命令](development.md#命令) 里的 `pnpm package` 和 [overview.md · 桌面端怎么启动宿主](architecture/overview.md#桌面端怎么启动宿主)。

## 已知细节

- 判断 Atrium 还在不在用 `ps -axo args=` 匹配主进程：这台机器上 `pgrep -f` 匹配不到 `/Applications/Atrium.app/Contents/MacOS/Atrium`（2026-11-05 实测，`pgrep -x Atrium` 也是空）。
- 脚本走 `/bin/sh`，不用 `EPOCHSECONDS`（zsh 才无条件有），时间戳用 `date +%s`。
- 作业跑完会 `launchctl bootout` 自己，`launchctl print` 随即找不到它；plist 在运行一开始就删掉了，所以重新登录不会再跑一次。
- 打包版和 `pnpm dev` 共用单实例锁和页面存储，同时只能开一个。
