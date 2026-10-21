import { renderToString } from "@plantuml/core";
import { DOMImplementation, DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { PlantumlRequest } from "./plantuml";
import { plantumlTheme } from "./plantuml-theme";

/** The worker's globals, which never receive the client, token, Node or a real document. */
const environment = globalThis;
/** Whether the engine tried to obtain a resource outside the bundled subset. */
let blockedResource = false;

/** Refuses any extra engine resource instead of downloading it.
 * @remarks The bundled engine may ask for standard libraries, emoji or themes. These are outside
 * this feature's supported subset; returning false would fall back to loading a script.
 * @sideEffects Reports a safe failure to the engine.
 * @param _name - The requested resource, deliberately ignored.
 * @param _success - The callback that must never receive external content.
 * @param failure - The engine's failure callback.
 */
function refuseResource(_name: string, _success: unknown, failure: (reason: string) => void): void {
  blockedResource = true;
  failure("resource_disabled");
}

/** Gives the string renderer its one required DOM-shaped API: canvas text measurement.
 * @remarks @plantuml/core's renderToString uses document.createElement('canvas') and window as
 * its global object. OffscreenCanvas provides real browser font metrics without a page DOM.
 * Other DOM paths fail closed rather than providing a fake layout or reaching the application.
 * @sideEffects Creates an offscreen text-measurement canvas.
 * @param name - The element the engine asked for.
 * @returns A real offscreen canvas.
 * @throws {Error} When a diagram requires an unsupported DOM operation.
 */
function createCanvas(name: string): OffscreenCanvas {
  if (name !== "canvas") throw new Error("unsupported_element");
  return new OffscreenCanvas(300, 150);
}

/** An inert XML document: it constructs SVG but cannot execute scripts or load resources. */
const xml = new DOMImplementation().createDocument(null, "root", null);
const createElementNS = xml.createElementNS.bind(xml);
/** The real browser metrics shared by text bounding-box requests. */
const metrics = new OffscreenCanvas(1, 1).getContext("2d");

/** Creates an inert SVG node, adding only the text measurement the engine needs.
 * @remarks XML nodes have no CSS layout. SVG text getBBox is supplied from real OffscreenCanvas
 * glyph metrics, so layout can run off-thread without a hidden iframe or approximate text widths.
 * @sideEffects Creates an XML node; measures text when the engine asks for its bounds.
 * @param namespace - The XML namespace.
 * @param name - The element name.
 * @returns The inert element with its restricted measurement surface.
 */
function createSvgElement(namespace: string, name: string) {
  const element = createElementNS(namespace, name);
  Object.defineProperties(element, {
    style: { value: {} },
    getBBox: {
      value: () => {
        if (name !== "text" || metrics === null) throw new Error("unsupported_measurement");
        const size = element.getAttribute("font-size") ?? "13";
        const family = element.getAttribute("font-family") ?? "sans-serif";
        metrics.font = `${size}px ${family}`;
        const measured = metrics.measureText(element.textContent ?? "");
        return {
          x: -measured.actualBoundingBoxLeft,
          y: -measured.actualBoundingBoxAscent,
          width: measured.actualBoundingBoxLeft + measured.actualBoundingBoxRight,
          height: measured.actualBoundingBoxAscent + measured.actualBoundingBoxDescent,
        };
      },
    },
  });
  return element;
}
Object.defineProperties(xml, {
  createElement: { value: createCanvas },
  createElementNS: { value: createSvgElement },
  body: { value: xml.documentElement },
});

Object.defineProperties(environment, {
  window: { value: globalThis },
  document: { value: xml },
  DOMParser: { value: DOMParser },
  XMLSerializer: { value: XMLSerializer },
  fetch: { value: undefined },
  XMLHttpRequest: { value: undefined },
  WebSocket: { value: undefined },
  EventSource: { value: undefined },
  importScripts: { value: undefined },
  PLANTUML_STDLIB_LOADER: { value: refuseResource },
  PLANTUML_FILE_LOADER: {
    value: (_path: unknown, _from: unknown, ok: unknown, fail: (reason: string) => void) =>
      refuseResource("", ok, fail),
  },
});

/** Reports a rendered diagram, not PlantUML's picture of a syntax error.
 * @remarks The engine delivers syntax-error illustrations through its success callback. Its
 * underlined source marker distinguishes those from actual diagrams in the locked engine version.
 * @sideEffects Parses inert XML and posts the result or a safe failure.
 * @param svg - The engine's SVG.
 */
function drawn(svg: string): void {
  if (blockedResource) {
    globalThis.postMessage({ failed: true });
    return;
  }
  if (new TextEncoder().encode(svg).length > 2 * 1024 * 1024) {
    globalThis.postMessage({ reason: "too_large" });
    return;
  }
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  // The engine checks size before applying `scale`; enforce the actual output dimensions too.
  const root = document.documentElement;
  const width = Number(root?.getAttribute("width"));
  const height = Number(root?.getAttribute("height"));
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 8192 ||
    height > 8192
  ) {
    globalThis.postMessage({ reason: "too_large" });
    return;
  }
  const texts = document.getElementsByTagName("text");
  for (let index = 0; index < texts.length; index += 1) {
    if (texts.item(index)?.getAttribute("text-decoration") === "wavy underline") {
      globalThis.postMessage({ failed: true });
      return;
    }
  }
  globalThis.postMessage({ svg });
}

/** Draws the single request this worker is allowed to receive.
 * @remarks Source and engine diagnostics are never logged or returned as errors. The parent owns
 * the hard deadline and terminates this worker, including a synchronous macro loop.
 * @sideEffects Runs the local engine and posts untrusted SVG or a stable failure to the parent.
 * @param event - The parent's bounded source and appearance.
 */
function draw(event: MessageEvent<PlantumlRequest>): void {
  globalThis.removeEventListener("message", draw);
  try {
    renderToString(
      plantumlTheme(event.data.source, event.data.dark),
      drawn,
      () => globalThis.postMessage({ failed: true }),
      {
        dark: event.data.dark,
        maxSvgSize: 8192,
      },
    );
  } catch {
    globalThis.postMessage({ failed: true });
  }
}

globalThis.addEventListener("message", draw);
