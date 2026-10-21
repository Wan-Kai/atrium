import { describe, expect, it } from "vitest";
import { plantumlTheme } from "./plantuml-theme";

const LIGHT = `skinparam backgroundColor transparent
skinparam shadowing false
skinparam roundCorner 8
skinparam defaultFontName "PingFang SC"
skinparam defaultFontSize 13
skinparam defaultFontColor #303641
skinparam ArrowColor #818997
skinparam sequence {
ParticipantBackgroundColor #FFFFFF
ParticipantBorderColor #C9CED7
ParticipantFontColor #303641
ParticipantFontSize 13
ParticipantBorderThickness 1
ArrowColor #818997
LifeLineBorderColor #818997
LifeLineBorderThickness 1
ArrowThickness 1
}
skinparam classBackgroundColor #FFFFFF
skinparam classBorderColor #C9CED7
skinparam classFontColor #303641
skinparam activityBackgroundColor #FFFFFF
skinparam activityBorderColor #C9CED7
skinparam activityFontColor #303641
skinparam componentBackgroundColor #FFFFFF
skinparam componentBorderColor #C9CED7
skinparam componentFontColor #303641
hide footbox`;

const DARK = `skinparam backgroundColor transparent
skinparam shadowing false
skinparam roundCorner 8
skinparam defaultFontName "PingFang SC"
skinparam defaultFontSize 13
skinparam defaultFontColor #E3E5E9
skinparam ArrowColor #A3A9B4
skinparam sequence {
ParticipantBackgroundColor #24262C
ParticipantBorderColor #555B65
ParticipantFontColor #E3E5E9
ParticipantFontSize 13
ParticipantBorderThickness 1
ArrowColor #A3A9B4
LifeLineBorderColor #A3A9B4
LifeLineBorderThickness 1
ArrowThickness 1
}
skinparam classBackgroundColor #24262C
skinparam classBorderColor #555B65
skinparam classFontColor #E3E5E9
skinparam activityBackgroundColor #24262C
skinparam activityBorderColor #555B65
skinparam activityFontColor #E3E5E9
skinparam componentBackgroundColor #24262C
skinparam componentBorderColor #555B65
skinparam componentFontColor #E3E5E9
hide footbox`;

describe("PlantUML B skin", () => {
  it.each([
    { dark: false, skin: LIGHT },
    { dark: true, skin: DARK },
  ])("inserts the approved skin before user overrides (dark=$dark)", ({ dark, skin }) => {
    const source =
      "' preface\r\n@startuml named\r\nskinparam sequenceParticipantBackgroundColor #FF0000\r\nAlice -> Bob\r\n@enduml\r\n";
    const rendered = plantumlTheme(source, dark);
    expect(rendered).toStrictEqual(
      `' preface\n@startuml named\n${skin}\nskinparam sequenceParticipantBackgroundColor #FF0000\nAlice -> Bob\n@enduml\n`.split(
        "\n",
      ),
    );
  });

  it.each([false, true])("does not guess other start tags or change their native theme (dark=%s)", (dark) => {
    expect(plantumlTheme("@startmindmap\r* Map\r@endmindmap", dark)).toStrictEqual([
      "@startmindmap",
      "* Map",
      "@endmindmap",
    ]);
    expect(plantumlTheme("Alice -> Bob", dark)).toStrictEqual(["Alice -> Bob"]);
    expect(plantumlTheme("' @startuml quoted\n@startmindmap\n* Map", dark)).toStrictEqual([
      "' @startuml quoted",
      "@startmindmap",
      "* Map",
    ]);
  });

  it("recognizes a BOM, indentation and case without changing opener or source lines", () => {
    expect(plantumlTheme("\uFEFF  @STARTUML name\nAlice -> Bob\n@enduml", false)).toStrictEqual([
      "\uFEFF  @STARTUML name",
      ...LIGHT.split("\n"),
      "Alice -> Bob",
      "@enduml",
    ]);
    expect(plantumlTheme("@startumlOther\nAlice -> Bob", true)).toStrictEqual(["@startumlOther", "Alice -> Bob"]);
  });
});
