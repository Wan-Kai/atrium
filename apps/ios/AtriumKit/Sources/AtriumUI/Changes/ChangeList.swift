import AtriumProtocol
import Foundation

/// A workspace's changed files as the change list shows them: counted, filtered, grouped or sorted.
///
/// - Remark: The final prototype's change list (SPEC-0005 "MP6 定的细节 · MP6a"): chips for all,
///   added, modified and deleted (a rename counts as modified); by default grouped by directory with
///   the root last as "根目录", or "按改动量排" without groups, the most changed first.
struct ChangeList: Equatable {
  /// Which files the chips show.
  enum Filter: CaseIterable, Equatable {
    /// Every file.
    case all
    /// New files.
    case added
    /// Changed or renamed files.
    case modified
    /// Removed files.
    case deleted

    /// The chip's name.
    var title: String {
      switch self {
      case .all: "全部"
      case .added: "新增"
      case .modified: "修改"
      case .deleted: "删除"
      }
    }

    /// Whether a file passes.
    ///
    /// - Remark: A rename is a modification here.
    /// - SideEffects: none
    /// - Parameter file: The file.
    /// - Returns: Whether it does.
    func includes(_ file: DiffFile) -> Bool {
      switch self {
      case .all: true
      case .added: file.status == .added
      case .modified: file.status == .modified || file.status == .renamed
      case .deleted: file.status == .deleted
      }
    }
  }

  /// One directory's files.
  struct Group: Equatable, Identifiable {
    /// The directory, with its slash, or "根目录".
    let directory: String
    /// Its files, in path order.
    let files: [DiffFile]
    /// What tells groups apart.
    var id: String { directory }
  }

  /// The files.
  let files: [DiffFile]

  /// Takes a diff's files.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter files: The files.
  init(_ files: [DiffFile]) {
    self.files = files
  }

  /// Lines added in all.
  var added: Int { files.reduce(0) { $0 + $1.added } }
  /// Lines removed in all.
  var removed: Int { files.reduce(0) { $0 + $1.removed } }

  /// How many files a chip shows.
  ///
  /// - Remark: See ``Filter``.
  /// - SideEffects: none
  /// - Parameter filter: The chip.
  /// - Returns: The count.
  func count(_ filter: Filter) -> Int {
    files.filter(filter.includes).count
  }

  /// The files a chip shows, by directory.
  ///
  /// - Remark: Directories in name order, the root last.
  /// - SideEffects: none
  /// - Parameter filter: The chip.
  /// - Returns: The groups.
  func groups(_ filter: Filter) -> [Group] {
    let shown = files.filter(filter.includes).sorted { $0.path < $1.path }
    let byDirectory = Dictionary(grouping: shown, by: Self.directory)
    return byDirectory.keys.sorted { left, right in
      if left.isEmpty || right.isEmpty { return !left.isEmpty }
      return left < right
    }
    .map { Group(directory: $0.isEmpty ? "根目录" : $0, files: byDirectory[$0] ?? []) }
  }

  /// The files a chip shows, the most changed first.
  ///
  /// - Remark: By lines added and removed together; ties by path.
  /// - SideEffects: none
  /// - Parameter filter: The chip.
  /// - Returns: The files.
  func bySize(_ filter: Filter) -> [DiffFile] {
    files.filter(filter.includes).sorted {
      ($0.added + $0.removed, $1.path) > ($1.added + $1.removed, $0.path)
    }
  }

  /// A file's name; a renamed one's old path and new name.
  ///
  /// - Remark: "旧名 → 新名" (SPEC-0005 "MP6 定的细节 · MP6a").
  /// - SideEffects: none
  /// - Parameter file: The file.
  /// - Returns: The name.
  static func name(_ file: DiffFile) -> String {
    let name = file.path.split(separator: "/").last.map(String.init) ?? file.path
    guard file.status == .renamed, let old = file.oldPath else { return name }
    return "\(old) → \(name)"
  }

  /// A file's directory, with its slash; empty at the root.
  ///
  /// - Remark: What groups go by.
  /// - SideEffects: none
  /// - Parameter file: The file.
  /// - Returns: The directory.
  static func directory(_ file: DiffFile) -> String {
    guard let slash = file.path.lastIndex(of: "/") else { return "" }
    return String(file.path[...slash])
  }

  /// A line count as the prototype writes it: "966", "2.2k", "15k".
  ///
  /// - Remark: One decimal under ten thousand.
  /// - SideEffects: none
  /// - Parameter count: The count.
  /// - Returns: The words.
  static func short(_ count: Int) -> String {
    if count < 1000 { return "\(count)" }
    if count < 10_000 { return String(format: "%.1fk", Double(count) / 1000) }
    return "\(count / 1000)k"
  }
}
