/** Adds the approved B defaults without changing the reply's original source.
 * @remarks Fixed local skin parameters avoid external themes and leave later user directives in
 * control. Explicit colours override the engine defaults in either appearance. Unsupported start
 * tags remain untouched rather than being guessed into a different diagram.
 * @sideEffects none
 * @param source - The original, already bounded PlantUML source.
 * @param dark - The application's current appearance.
 * @returns Engine lines with local defaults after the UML opener.
 */
export function plantumlTheme(source: string, dark: boolean): string[] {
  const lines = source.split(/\r\n|\r|\n/u);
  const start = lines.findIndex((line) => /^\s*@startuml\b/iu.test(line));
  if (start === -1) return lines;
  const fill = dark ? "#24262C" : "#FFFFFF";
  const border = dark ? "#555B65" : "#C9CED7";
  const ink = dark ? "#E3E5E9" : "#303641";
  const line = dark ? "#A3A9B4" : "#818997";
  const skin = [
    "skinparam backgroundColor transparent",
    "skinparam shadowing false",
    "skinparam roundCorner 8",
    'skinparam defaultFontName "PingFang SC"',
    "skinparam defaultFontSize 13",
    `skinparam defaultFontColor ${ink}`,
    `skinparam ArrowColor ${line}`,
    "skinparam sequence {",
    `ParticipantBackgroundColor ${fill}`,
    `ParticipantBorderColor ${border}`,
    `ParticipantFontColor ${ink}`,
    "ParticipantFontSize 13",
    "ParticipantBorderThickness 1",
    `ArrowColor ${line}`,
    `LifeLineBorderColor ${line}`,
    "LifeLineBorderThickness 1",
    "ArrowThickness 1",
    "}",
    ...["class", "activity", "component"].flatMap((kind) => [
      `skinparam ${kind}BackgroundColor ${fill}`,
      `skinparam ${kind}BorderColor ${border}`,
      `skinparam ${kind}FontColor ${ink}`,
    ]),
    "hide footbox",
  ];
  return [...lines.slice(0, start + 1), ...skin, ...lines.slice(start + 1)];
}
