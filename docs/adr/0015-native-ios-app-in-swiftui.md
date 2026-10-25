# ADR-0015：手机端做 SwiftUI 原生 iOS App，先不做推送

- **状态**：已接受
- **日期**：2026-10-24
- **相关**：取代 [ADR-0005](0005-split-host-and-ui-pwa-first.md) 第 4 条（手机端先走 PWA）；[ADR-0016](0016-remote-access-through-own-relay-with-noise.md)（手机怎么连回宿主）；[mobile-remote.md](../research/mobile-remote.md)（调研）

## 背景

ADR-0005 定的是手机端先做响应式界面加 PWA，以后需要时再用 Expo / React Native 做精简版原生 App。2026-10-24 调研完各家的手机端（mobile-remote.md）后，用户定了要做一个单独的 App。手机上主要是看进度、插话、停止、回答提问和批准、看 diff，深度功能留在桌面（ADR-0005 的场景判断不变）。

约束：

- **只做 iOS**：用户用的是 iPhone，自用为主。
- **没有付费的 Apple 开发者账号**：用免费账号签名，App 每 7 天要重签一次（Xcode 重装，或 SideStore 一类工具在手机上续签）；同一台设备最多 3 个自签名的 App。按 Apple 的功能对照表，免费账号**用不了推送**，App Groups 等也用不了。
- PWA 的代码从网址加载，下发这段代码的服务器能换掉做加密的 JS（ADR-0016"背景"）；原生 App 的代码是签名打包进去的，没有这个问题。

## 决策

1. **用 SwiftUI 写纯原生的 iOS App**，放在 `apps/ios`（Xcode 工程）。不复用 `packages/ui` 和 `packages/client`；协议的定义仍只在 `packages/protocol`。
2. **Swift 的协议类型由 zod 生成**：从 `packages/protocol` 用 `z.toJSONSchema`（zod 4）导出 JSON Schema，再生成 Swift 的 `Codable` 类型，生成的文件提交进仓库。协议改了却没重新生成时，检查要失败。另写一组"Swift 客户端连真实宿主"的契约测试，覆盖握手、列表同步、对话补齐、发消息、回答提问。
3. **手机上做的事**（细节写进手机端的 SPEC）：
   - 工作区和会话列表；
   - 看对话和实时进度；
   - 发消息、插话、排队、停止；
   - 回答提问和批准；
   - 看改动的 diff；
   - 新建会话、换模型和思考档位。
   
   不做：终端、编辑文件、设置和 pi 配置、登录、插件。
4. **渲染**：Markdown 和代码高亮用 Swift 的库；Mermaid、PlantUML 第一版先显示原文。选什么库在 SPEC 里定。
5. **先不做推送**（用户定）。App 在前台时实时同步，回到前台时立刻探活、按游标补齐。以后有了付费账号再做推送：relay 用 APNs 发加密的内容，App 的通知扩展（Notification Service Extension）在本机解密后显示（ADR-0016 第 8 条）。
6. **工程规范补上 Swift 一套**：开工前在 coding-standards.md、testing.md 补 Swift 的格式化、静态检查、测试（Swift Testing）和文档注释规则，`pnpm check` 里加上能在命令行跑的那部分。没定之前不写 Swift 代码。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| PWA（ADR-0005 原定） | 几乎不加技术栈，复用整个 `ui` | 代码从网址加载，难以保证端到端加密；推送要先添加到主屏幕，后台能力弱；用户想要单独的 App |
| Capacitor 外壳加载现有 React 界面 | 复用 Markdown、代码、图表、diff 的渲染，工作量最小 | 网页视图的手感不如原生；推送、钥匙串要靠插件 |
| Expo / React Native | 手感接近原生，复用 `protocol` 和 `client` | 界面和渲染要重写；多一套 RN 工具链 |
| SwiftUI 原生（采用） | 手感最好；钥匙串、相机扫码、通知扩展、灵动岛都是一等能力；代码签名打包，加密的信任边界清楚 | 协议、同步、加密、渲染都要用 Swift 再写一遍；只有 iOS；仓库多一种语言和一套工具 |

## 后果

- **正面**：
  - 手机端的体验和系统能力不受网页限制；
  - 端到端加密的代码不经过网络下发；
  - 以后接推送、灵动岛只是加能力，不换栈。
- **负面 / 代价**：
  - 协议要两边跟着改。Atrium 的协议到第 25 版几乎每个里程碑都在改，靠生成类型和契约测试守住，漏了就是手机端悄悄坏掉。
  - 同步逻辑（游标、补齐、乐观消息、重连）要在 Swift 里再实现一遍，桌面上踩过的坑可能再踩一次。
  - 免费账号每 7 天重签，忘了续签 App 就打不开。
  - 没有推送：手机不打开就不知道 agent 做完了或在等回答。
  - 开发和测试要 Xcode，变异测试、泄漏测试这套 TypeScript 工具不能直接用。
- **什么情况下应重新评估**：
  - 有了付费开发者账号：做推送、TestFlight；
  - 要支持 Android：重新比较 Capacitor / RN；
  - Swift 侧跟不上协议改动、反复出错时：考虑缩小手机端用到的协议面，或者改成复用现有界面的外壳方案。
