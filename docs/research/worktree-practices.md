# worktree 的做法调研：Claude Code 与 pi 扩展

- **日期**：2026-11-04
- **目的**：给任务图（`task-graph-execution.md`）的工作区设计找参考，看别人怎么建、怎么隔离、怎么清理 worktree。
- **结论先行**：值得拿的是 Claude Code 的六件事（§3）：要写才建 worktree、按路径强制隔离、`.worktreeinclude`、运行时加锁、按状态自动清理、建 worktree 时不跑仓库的过滤器。pi 扩展那边，可取的主要是几条安全细节和"pi 不能换目录"这个事实。

## 1. Claude Code

来源：[Run parallel sessions with worktrees](https://code.claude.com/docs/en/worktrees)、[agent view · How file edits are isolated](https://code.claude.com/docs/en/agent-view)（2026-11-04 读）。

### 1.1 什么时候建：要写的时候才建（"动态 worktree"）

后台会话从你的工作目录起，能读同一个检出目录；**第一次要改文件之前**，Claude 才把会话挪进 `.claude/worktrees/` 下新建的 worktree。挪进去之前，`Edit` / `Write` / `NotebookEdit` 对共享的检出目录一律不可用。以下几种情况不建：会话本来就在一个链接 worktree 里；目录不是 git 仓库；写的位置在工作目录之外；设置 `worktree.bgIsolation: "none"`。

会话中途也可以用 `EnterWorktree` 进 worktree、`ExitWorktree` 出来，出来时选保留还是删除。删除时，有未提交改动或分支上有提交，就要显式 `discard_changes`。

### 1.2 进去之后：四项强制检查

1. **改文件**：`Edit` / `Write` 的目标在主检出目录里，就拦下。
2. **命令的工作目录**：Bash 的工作目录落在主检出目录，或者无法确认它在 worktree 里，就拦下。
3. **git 重定向**：`git -C`、`--git-dir`、`GIT_DIR` / `GIT_WORK_TREE`，或者先 `cd` 到主检出目录再跑 git，都拦下。
4. **命令形状**：从命令文本看不出里面的 git 会不会跑出 worktree（命令名是运行时算出来的、解析不了、有间接展开），就拦下，并告诉模型怎么改写。

文档明说：这些检查只看路径、工作目录和命令文本，`cp`、重定向写进主检出目录是拦不住的，要靠权限和沙箱。同一套检查也作用于这个会话开的子 agent。

### 1.3 从哪里分出来

- `worktree.baseRef: "fresh"`（默认）：从远端默认分支分出来；超过 24 小时没 fetch 就先 fetch，最多等 5 秒，失败就用本地缓存；没有远端时退回本地 HEAD。
- `"head"`：从当前本地 HEAD 分出来，带上没推送的提交。在 worktree 里用时，指的是那个 worktree 自己的 HEAD。适合让子 agent 接着做手上没做完的事。
- 不能写分支名；要从某个分支起，就自己 `git worktree add`。

### 1.4 环境：`.worktreeinclude`

worktree 是全新的检出，没有 `.env` 这类被忽略的文件。项目根放一个 `.worktreeinclude`（`.gitignore` 语法），**只有既匹配这个文件、又被 git 忽略的文件**才会复制进新 worktree，已跟踪的文件不会重复复制。依赖不会自动装，要 agent 去装，或者自己跑。

### 1.5 加锁与清理

- agent 在跑时，Claude Code 对它的 worktree 执行 `git worktree lock`，防止并发清理删掉它，结束时解锁。进程已经退出的会话留下的锁，在下次清扫时释放；你自己加的锁永远不动。
- 子 agent 的 worktree：**结束时没有改动就自动删掉**；有改动的留着，等定期清扫。清扫的条件是超过 `cleanupPeriodDays`，并且没有未提交或未跟踪的文件、没有未推送的提交、子模块干净。
- Claude Code 在自己建的每个 worktree 的 git 元数据里写一个标记。清扫只删带标记的；你用 `git worktree add` 建的永远不删。
- 交互会话退出时：干净的 worktree 直接删（有名字的会话先问）；有东西的问你保留还是删除；状态查不清的也问，不自动删。

### 1.6 安全细节

- **建 worktree 时不跑仓库自己的过滤器**（git LFS 之类写在 `.git/config` 里的 filter）。理由是过滤器就是一条 shell 命令，而任何能写仓库的东西都可能放进去一个，包括 agent 自己。代价是 LFS 文件在 worktree 里是指针，要手动 `git lfs pull`。
- 采用一个目录当 worktree 之前，先核对它的 git 身份：如果它的 `.git` 指回主仓库、或者有 `core.worktree` 重定向，在里面 `git reset --hard` 就会打到主检出目录上，这种目录一律拒绝使用。
- `.claude/worktrees` 这条路径上任何一级是符号链接，就拒绝建 worktree。
- 恢复会话时，如果 worktree 目录已经不在了，就回到启动目录继续，并清掉会话和 worktree 的绑定。

### 1.7 结果怎么交

后台会话在 worktree 里改了代码后，会自己提交，有远端就推分支，需要时开 draft PR。它**从不**推 `main` / `master`、从不强推、从不合并。如果你的 CLAUDE.md 说 git 由你自己来，它就不动 git。每件事结束时报告结果在哪：路径、分支、PR，或者答案本身。

### 1.8 其他

- 一个子 agent 在自己的 worktree 里时，指令文件（CLAUDE.md、rules）取主对话的，不取 worktree 分支上的。
- 和主检出目录共享：`.git`、插件、权限批准记录、没进版本库的 skills、agents、commands。
- 非 git 的版本控制可以用 `WorktreeCreate` / `WorktreeRemove` 钩子整个替换掉创建和清理逻辑。

## 2. pi 的 worktree 扩展

2026-11-04 用 `npm pack --ignore-scripts` 下了 8 个包，只读了 README 和部分源码，没有执行。

| 包 | 做法 | 可取之处 |
|---|---|---|
| [`@tylerho/pi-worktree`](https://www.npmjs.com/package/@tylerho/pi-worktree) 0.2.1 | 照搬 Claude Code 2.1.229 的 `enter_worktree` / `exit_worktree` | 说清了 **pi 没有真正的 chdir**：内置工具创建时就把 cwd 固定在闭包里，所以"进 worktree"只能重新注册七个带 cwd 的代理工具。状态按会话 id 存进文件；每个 worktree 一个锁文件，记 pid，用 `kill(pid, 0)` 判断持锁的进程还在不在；子会话拿不到这两个工具，不能挪父会话的目录。退出时，干净且没有新提交的 worktree 直接删 |
| [`pi-worktree`](https://www.npmjs.com/package/pi-worktree) 1.3.3 | `pi --worktree` 建好后**重新启动 pi** 到新目录 | 同样因为 pi 不能换目录，干脆重启进程。项目里 `.pi/worktree.json` 配 `postCreate`（装依赖、建库）、`preRemove`（删库），以及把 `.env*` 软链过去 |
| [`pi-worktree-extension`](https://www.npmjs.com/package/pi-worktree-extension) 2.0.5 | 一个 worktree 对应一段可恢复的对话 | 按任务名恢复：重新打开 worktree 就接着它最近的会话；能把当前对话带进 worktree。生命周期保守：只删干净且不在用的，分支永远保留，从不强制删除 |
| [`@djoeyg/pi-worktree`](https://www.npmjs.com/package/@djoeyg/pi-worktree) 0.1.0 | 每个 worktree 一个 `pi --mode rpc` 子进程，在 pi 里开成标签 | 每个 worktree 起在自己目录里的 pi，**用的是它自己的 `AGENTS.md` 和项目设置**；信任沿用主检出目录的决定（新路径没有信任记录，RPC 模式又不能问）；扩展弹的对话框转到主界面上显示 |
| [`@rezamonangg/pi-worktree`](https://www.npmjs.com/package/@rezamonangg/pi-worktree) 0.1.3 | pi 留在原目录，文件和 bash 工具**按路径改道**到 worktree | 写入其他 worktree、`../` 和系统路径一律拦下；用真实路径解析防符号链接逃逸；bash 带上 `PI_WORKTREE_ROOT` 环境变量；另有 `worktree_diff` / `sync` / `commit` / `stop` / `rescue_leftovers` 工具。缺点：pi 的状态栏仍显示原目录，容易糊涂 |
| [`@narumitw/pi-worktree`](https://www.npmjs.com/package/@narumitw/pi-worktree) 0.51.9 | 交互式管理器，每一步变更前都要确认 | **先把起点解析成完整的提交号，再从这个号建**，即使引用之后被移动也不受影响；建完再核对 worktree 的 HEAD；参数直接传给 git，不拼 shell；删除前检查已跟踪、未跟踪、暂存区、子模块、游离提交，列出会丢的被忽略文件，确认后再按批准的计划重新核对一次 |
| [`@zenobius/pi-worktrees`](https://www.npmjs.com/package/@zenobius/pi-worktrees) 0.5.1 | `/worktree create/list/remove/prune` 命令 | 按 glob 匹配仓库的设置（`worktreeRoot` 模板、`onCreate` 命令），可以顺手开终端标签 |
| [`@deepseek-ai/dsh-experimental-worktree`](https://www.npmjs.com/package/@deepseek-ai/dsh-experimental-worktree) 0.2.1-alpha.2 | DeepSeek harness 的服务加工具：从本地提交建，**同一个会话**换到新目录 | 只从本地提交建（不 fetch、不复制未提交的文件、不装依赖、不初始化子模块）；检出时跳过过滤器，理由同 Claude Code；目录独占申请；离开时保留文件和分支，删除留给别人 |

另外从 web 上看到，[`randomm/pi-worktree`](https://github.com/randomm/pi-worktree)（0.1.0，还在开发）主张删除分三步，先删目录、再 `git worktree prune`，顺序不能反；持久化的数据坏了就拒绝操作（fail-closed）。[`@carter-mcalister/pi-worktrunk`](https://pi.dev/packages/@carter-mcalister/pi-worktrunk) 把创建、删除、钩子都交给 Worktrunk（`wt`），自己只是一层薄包装。

## 3. 对 Atrium 任务图的启发

Atrium 已经有的（SPEC-0001 M1.11、SPEC-0002）：

- 新建 worktree 时记下起点提交；
- 安全归档：查未提交和游离提交，停掉 pi 后再查一遍；
- 恢复；
- 合并状态；
- 中文显示名；
- 每个会话的 pi 直接起在它的工作目录里；
- SPEC-0002 的子对话可以分叉进新 worktree。

这些不用再学。下面只列缺的。

### 第一版就拿

1. **要写才建 worktree**（Claude Code §1.1）。我们讨论稿里已经是这个思路，现在规则明确为：
   - 来源对话本来就在 worktree 里，直接用它；
   - 否则到第一个 `work` 节点要开跑时，调度器先建 worktree，再起这个节点。
   - 在这之前的只读节点在原目录跑；
   - 不属于项目的任务没有 `work` 节点，永远不建。
   - 建的时机是在**调度器**里，不是让模型调 `EnterWorktree`：节点的 pi 本来就按节点起，直接起在 worktree 里，绕开了"pi 不能换目录"的问题（`@tylerho`、`pi-worktree` 为此做的代理工具和重启都不需要）。
2. **按路径强制隔离**（Claude Code §1.2 的第 1、2、3 项）。任务扩展在 `tool_call` 钩子里拦三类调用：
   - `edit` / `write` 的目标路径（按真实路径解析）不在节点的工作目录里；
   - `bash` 的工作目录不在节点的工作目录里；
   - 命令里有 `git -C`、`--git-dir`、`GIT_DIR=`、`GIT_WORK_TREE=` 指向别处。

   第 4 项"命令形状"太重，第一版不做。照 Claude Code 文档的写法如实告诉用户：`cp` 和重定向拦不住。这和讨论稿里"越界靠契约"不冲突：契约管的是"别做下游的事"，这里管的是"别写到别的目录"。
3. **起点固定成提交号**（`@narumitw`）。建 worktree 前先把起点解析成完整的提交号，再从这个号建，建完核对 HEAD，并记进 NodeRun 和工作区记录。起点取来源对话所在目录当前的 HEAD，相当于 Claude Code 的 `"head"`：任务往往接着手上的事做，不该从远端主干重新开始。
4. **`.worktreeinclude`**（Claude Code §1.4）。照搬它的规则和文件名：只复制既匹配、又被 git 忽略的文件；**用复制，不用软链**（避免 worktree 里的修改写回主目录的 `.env`）。同名的好处是和 Claude Code 的项目通用。所有 Atrium 新建的 worktree 都适用，不只任务的。
5. **任务在用的 worktree 加锁**（Claude Code §1.5）。任务从 `running` 起对 worktree 执行 `git worktree lock --reason "atrium task <id>"`，到 `done` / `cancelled` 时解锁。归档、清理遇到锁着的应答错误码，界面写"任务 X 正在用"。宿主启动时检查：锁的原因是 Atrium 任务、但任务已经结束的，解锁。
6. **建 worktree 时不跑仓库的过滤器**（Claude Code §1.6、DeepSeek）。理由在任务图里更强：agent 会在共享的 `.git/config` 所在的仓库里干活，能写进一个 filter，下一个建出来的 worktree 就会执行它。做法是建的时候临时把 `filter.<名字>.process/smudge/clean` 覆盖成空的（`-c` 参数），LFS 文件留成指针。这一条要写进 security.md。
7. **按状态清理**（Claude Code §1.5、`pi-worktree-extension`）：
   - 任务建的 worktree 在索引里记"由任务 X 创建"，相当于 Claude Code 的标记；
   - 任务 `done` 且已合并：走现有的归档；
   - 任务 `cancelled`：worktree 干净、相对起点没有提交，就直接归档；否则保留，任务列表这一行写"worktree 里还有改动"；
   - 来源对话原本就在的 worktree 不是任务建的，任务永远不删它。
8. **新 worktree 先装依赖，交给节点做**（DeepSeek 的"不装依赖"，Claude Code 的"让 agent 装"）。宿主不跑项目的安装命令；第一个 `work` 节点的契约里多一句"这是新建的 worktree，还没有装依赖，先按项目说明装好"。`postCreate` 这类项目配置留到以后。

### 以后再说

- 并行的可写节点各开一个 worktree（Claude Code 的子 agent `isolation: worktree`）：从共同上游结束时的提交建，结束时没有改动就自动删，汇合节点负责合回任务 worktree。第一版按讨论稿排队。
- 项目级的 `postCreate` / `preRemove`（`pi-worktree`、`@zenobius`）：独立的数据库、端口这些。
- 采用目录前核对 git 身份（Claude Code §1.6）：现在 Atrium 只用自己建的和 `git worktree list` 列出的目录，风险小，先不做。

### 不拿

- 按路径改道（`@rezamonangg`）：pi 停在原目录、工具偷偷改到别处，状态栏和 `pwd` 对不上，模型和人都容易糊涂。我们直接把节点的 pi 起在对的目录里。
- 模型自己调 `EnterWorktree`：建不建、建在哪由调度器决定，不让节点决定（Q6 已定节点不开子对话，同理）。
- 自动推送、开 PR（Claude Code §1.7）：Atrium 只在明确要求时推送，合并在"验收合并"节点里做。
- 子 agent 用主对话的指令文件（Claude Code §1.8）：Atrium 的节点起在 worktree 里，读的是 worktree 分支上的 `AGENTS.md`，这正是我们要的（任务可能改了守则，后面的节点应该按新版本来）。
