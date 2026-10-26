#if DEBUG
  import AtriumProtocol
  import SwiftUI

  /// The gallery's diff sample: the prototype's `ttl.ts` change, plus a hunk with a long unchanged
  /// stretch that folds.
  ///
  /// - Remark: See `DesignGallery`.
  struct GalleryDiff: View {
    /// Whether lines wrap.
    @State private var wrap = false

    /// The diff.
    var body: some View {
      VStack(alignment: .leading, spacing: Metrics.sm) {
        Toggle("换行", isOn: $wrap).font(Typography.meta).fixedSize()
        DiffView(hunks: Self.hunks, wrap: wrap)
          .padding(.horizontal, -Metrics.page)
      }
    }

    /// Builds a hunk from marked lines, numbering them as git does.
    ///
    /// - Remark: " " context, "+" added, "-" deleted.
    /// - SideEffects: none
    /// - Parameters:
    ///   - old: The first old line number.
    ///   - new: The first new line number.
    ///   - lines: The marked lines.
    /// - Returns: The hunk.
    static func hunk(old: Int, new: Int, _ lines: [(Character, String)]) -> DiffHunk {
      var oldNumber = old
      var newNumber = new
      var built: [DiffLine] = []
      for (mark, text) in lines {
        switch mark {
        case "+":
          built.append(DiffLine(kind: .add, oldNumber: nil, newNumber: newNumber, text: text))
          newNumber += 1
        case "-":
          built.append(DiffLine(kind: .del, oldNumber: oldNumber, newNumber: nil, text: text))
          oldNumber += 1
        default:
          built.append(DiffLine(kind: .context, oldNumber: oldNumber, newNumber: newNumber, text: text))
          oldNumber += 1
          newNumber += 1
        }
      }
      return DiffHunk(
        oldStart: old, oldCount: oldNumber - old, newStart: new, newCount: newNumber - new, lines: built)
    }

    /// The sample's hunks.
    static let hunks: [DiffHunk] = [
      hunk(
        old: 1, new: 1,
        [
          (" ", #"import { now } from "../clock";"#), ("-", #"import { LRU } from "./lru";"#),
          ("+", #"import { sweep } from "./sweep";"#), ("+", #"import type { Entry, PutOptions } from "./types";"#),
          (" ", ""), (" ", "const DEFAULT_TTL_SECONDS = 600;"),
        ]),
      hunk(
        old: 30, new: 31,
        [
          (" ", "export function put(key: string, value: Forecast, options: PutOptions = {}) {"),
          ("-", "  const expiresAt = now() + DEFAULT_TTL_SECONDS;"),
          ("+", "  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;"),
          ("+", "  const expiresAt = Math.floor(now() / 1000) + ttl; // 秒，和服务端一致"),
          ("+", "  if (store.size > MAX_ENTRIES) sweep(store);"),
        ] + (0..<14).map { (" ", "  // unchanged line \($0)") } + [("+", "  return expiresAt;"), (" ", "}")]),
    ]
  }
#endif
