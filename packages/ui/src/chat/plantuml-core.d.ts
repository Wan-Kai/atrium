/** The verified public API of @plantuml/core 1.2026.9, which ships no TypeScript declarations. */
declare module "@plantuml/core" {
  /** Renders SVG through callbacks without inserting anything into a document. */
  export function renderToString(
    lines: string[],
    success: (svg: string) => void,
    failure: (message: string) => void,
    options: { dark: boolean; maxSvgSize: number },
  ): void;
}
