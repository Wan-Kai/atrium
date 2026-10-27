import AtriumProtocol
import Foundation
import Testing

@testable import AtriumUI

/// A file of a diff, as JSON.
///
/// - Remark: Without hunks; the list does not read them.
/// - SideEffects: none
/// - Parameters:
///   - path: Its path.
///   - status: `added`, `deleted`, `modified` or `renamed`.
///   - added: Lines added.
///   - removed: Lines removed.
/// - Returns: The JSON.
func diffFileJSON(_ path: String, _ status: String = "modified", added: Int = 1, removed: Int = 0) -> String {
  let old = status == "renamed" ? "\"old/\(path)\"" : "null"
  return
    #"{"path":"\#(path)","oldPath":\#(old),"status":"\#(status)","added":\#(added),"removed":\#(removed),"content":"text","hunks":[]}"#
}

/// The files of a diff.
///
/// - Remark: Decoded as the host sends them.
/// - SideEffects: none
/// - Parameter files: The files, as JSON.
/// - Returns: The files.
/// - Throws: When the JSON does not decode.
func diffFiles(_ files: [String]) throws -> [DiffFile] {
  try JSONDecoder().decode([DiffFile].self, from: Data("[\(files.joined(separator: ","))]".utf8))
}

@Suite("Change list")
struct ChangeListTests {
  @Test("counts the files by kind and sums the lines")
  func counts() throws {
    let list = ChangeList(
      try diffFiles([
        diffFileJSON("src/a.ts", "added", added: 10), diffFileJSON("src/b.ts", added: 2, removed: 3),
        diffFileJSON("README.md", "deleted", added: 0, removed: 7), diffFileJSON("src/c.ts", "renamed", added: 0),
      ]))
    #expect(list.count(.all) == 4)
    #expect(list.count(.added) == 1)
    #expect(list.count(.modified) == 2)
    #expect(list.count(.deleted) == 1)
    #expect(list.added == 12)
    #expect(list.removed == 10)
  }

  @Test("groups by directory, the root last and named so, files in path order")
  func groups() throws {
    let list = ChangeList(
      try diffFiles([
        diffFileJSON("src/z.ts"), diffFileJSON("README.md"), diffFileJSON("src/a.ts"), diffFileJSON("lib/x.ts"),
      ]))
    let groups = list.groups(.all)
    #expect(groups.map(\.directory) == ["lib/", "src/", "根目录"])
    #expect(groups[1].files.map(\.path) == ["src/a.ts", "src/z.ts"])
  }

  @Test("sorts by how much changed, without groups, and filters by kind")
  func bySize() throws {
    let list = ChangeList(
      try diffFiles([
        diffFileJSON("a.ts", added: 1), diffFileJSON("b.ts", "added", added: 50),
        diffFileJSON("c.ts", added: 5, removed: 5),
      ]))
    #expect(list.bySize(.all).map(\.path) == ["b.ts", "c.ts", "a.ts"])
    #expect(list.bySize(.modified).map(\.path) == ["c.ts", "a.ts"])
    #expect(list.groups(.added).flatMap(\.files).map(\.path) == ["b.ts"])
  }

  @Test("shortens line counts as the prototype does")
  func short() {
    #expect(ChangeList.short(966) == "966")
    #expect(ChangeList.short(2200) == "2.2k")
    #expect(ChangeList.short(15_000) == "15k")
  }

  @Test("names a file and its directory, and a renamed one by both names")
  func names() throws {
    let files = try diffFiles([diffFileJSON("src/radar/a.ts"), diffFileJSON("b.ts", "renamed")])
    #expect(ChangeList.name(files[0]) == "a.ts")
    #expect(ChangeList.directory(files[0]) == "src/radar/")
    #expect(ChangeList.name(files[1]) == "old/b.ts → b.ts")
  }
}
