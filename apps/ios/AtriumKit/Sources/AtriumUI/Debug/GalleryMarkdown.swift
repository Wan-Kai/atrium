#if DEBUG
  import AtriumRender
  import SwiftUI

  /// Exercises native reply blocks with made-up Markdown, including diagram fallbacks.
  ///
  /// - Remark: Static first render uses the same worker as growing replies; no network is involved.
  struct GalleryMarkdown: View {
    /// The sample document.
    static let sample = """
      ## 已修好缓存过期

      原因是 `expiresAt` 存的是**秒**，比较时却用了毫秒。现在统一单位。

      - 保留 **中文与 Latin** 混排
      - 读了 3 个文件，增加了 3 个测试
      - [x] 到期时重新获取
      - [ ] 真机验收

      ```typescript
      export function isFresh(entry: Entry) {
        return entry.expiresAt * 1000 > Date.now();
      }
      ```

      | 场景 | 结果 |
      | --- | ---: |
      | TTL = 0 | 通过 |
      | 已过期 | 通过 |
      | 未过期 | 通过 |

      > 没有修改网络请求行为。

      ```mermaid
      graph LR; cache --> refresh
      ```
      """

    /// A static reply on the page surface.
    var body: some View {
      StreamingReplyView(source: Self.sample, streaming: false, clock: ContinuousClock())
    }
  }
#endif
