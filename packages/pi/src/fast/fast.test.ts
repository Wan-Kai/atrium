import { describe, expect, it } from "vitest";
import { type FastInfo, type FastTiers, fastOf, readFastReport, tiersFromModelList } from "./fast";

/**
 * Reads a body that must be Codex's list.
 *
 * @remarks
 * Keeps the tests free of conditionals.
 *
 * @sideEffects none
 * @param body - The body.
 * @returns The models it names.
 * @throws {Error} When it is not the list.
 */
function listed(body: unknown): Map<string, FastInfo | null> {
  const tiers = tiersFromModelList(body);
  if (tiers === null) throw new Error("not Codex's list");
  return tiers;
}

/** What the built-in rule gives. */
const FALLBACK = { speed: null, moreUsage: true };

describe("fastOf", () => {
  it.each(["gpt-5.5", "gpt-5.6", "gpt-5.6-sol", "gpt-6", "gpt-6-astra", "gpt-6.1", "gpt-6.1-sol", "gpt-5.5-codex"])(
    "gives ChatGPT's %s Fast by the built-in rule when there is no list",
    (id) => {
      expect(fastOf({ provider: "openai-codex", id }, null)).toStrictEqual(FALLBACK);
    },
  );

  it.each([
    ["GPT-5.4", "openai-codex", "gpt-5.4"],
    ["an older GPT", "openai-codex", "gpt-5.3-codex"],
    ["a newer GPT", "openai-codex", "gpt-6.2"],
    ["a version that only starts like one", "openai-codex", "gpt-5.55"],
    ["a version that only starts like 6", "openai-codex", "gpt-60"],
    ["a name with the version inside", "openai-codex", "my-gpt-5.5"],
    ["the same model by API key", "openai", "gpt-5.5"],
    ["another provider", "anthropic", "claude-opus-5-5"],
  ])("gives %s no Fast by the built-in rule", (_case, provider, id) => {
    expect(fastOf({ provider, id }, null)).toBeNull();
  });

  it("goes by the list for the models it names, with Fast or without, and by the rule for the rest", () => {
    const tiers: FastTiers = new Map([
      ["gpt-6.1-sol", { speed: 2, moreUsage: true }],
      ["gpt-5.5", null],
      ["gpt-5.4", { speed: 1.5, moreUsage: false }],
    ]);

    expect(
      ["gpt-6.1-sol", "gpt-5.5", "gpt-5.4", "gpt-6"].map((id) => fastOf({ provider: "openai-codex", id }, tiers)),
    ).toStrictEqual([{ speed: 2, moreUsage: true }, null, { speed: 1.5, moreUsage: false }, FALLBACK]);
  });

  it("gives another provider no Fast whatever the list says", () => {
    expect(fastOf({ provider: "openai", id: "gpt-6.1-sol" }, new Map([["gpt-6.1-sol", FALLBACK]]))).toBeNull();
  });
});

describe("tiersFromModelList", () => {
  it("reads each model's priority tier from Codex's list", () => {
    const body = {
      models: [
        {
          slug: "gpt-6.1-sol",
          service_tiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }],
        },
        { slug: "gpt-6-sol", service_tiers: [{ id: "flex" }, { id: "priority", description: "1.5x speed" }] },
        { slug: "gpt-5.5", service_tiers: [{ id: "priority", description: "1.5X Speed, Increased Usage" }] },
        { slug: "gpt-5.4", service_tiers: [] },
        { slug: "gpt-5.3", service_tiers: [{ id: "flex" }] },
        { slug: "gpt-5.2" },
        { slug: "odd", service_tiers: [{ id: "priority", description: "faster" }] },
        { slug: "silent", service_tiers: [{ id: "priority" }] },
        { slug: "huge", service_tiers: [{ id: "priority", description: "500x speed" }] },
        { slug: "still", service_tiers: [{ id: "priority", description: "0x speed" }] },
        { slug: "tens", service_tiers: [{ id: "priority", description: "10x speed" }] },
        { slug: "most", service_tiers: [{ id: "priority", description: "100x speed" }] },
        { slug: "fine", service_tiers: [{ id: "priority", description: "1.25x speed" }] },
        { slug: "spaced", service_tiers: [{ id: "priority", description: "2 x  speed" }] },
        { slug: "boxed", service_tiers: [{ id: "priority", description: ["2x speed, increased usage"] }] },
        { slug: "loose", service_tiers: ["priority", null, 5] },
        { slug: "list", service_tiers: "priority" },
      ],
    };

    expect(Object.fromEntries(listed(body))).toStrictEqual({
      "gpt-6.1-sol": { speed: 2, moreUsage: true },
      "gpt-6-sol": { speed: 1.5, moreUsage: false },
      "gpt-5.5": { speed: 1.5, moreUsage: true },
      "gpt-5.4": null,
      "gpt-5.3": null,
      "gpt-5.2": null,
      odd: { speed: null, moreUsage: false },
      silent: { speed: null, moreUsage: false },
      huge: { speed: null, moreUsage: false },
      still: { speed: null, moreUsage: false },
      tens: { speed: 10, moreUsage: false },
      most: { speed: 100, moreUsage: false },
      fine: { speed: 1.25, moreUsage: false },
      spaced: { speed: 2, moreUsage: false },
      boxed: { speed: null, moreUsage: false },
      loose: null,
      list: null,
    });
  });

  it("skips models without a usable slug", () => {
    const body = {
      models: [null, "gpt-5.5", {}, { slug: 5 }, { slug: "" }, { slug: "x".repeat(201) }, { slug: "x".repeat(200) }],
    };

    expect([...listed(body).keys()]).toStrictEqual(["x".repeat(200)]);
  });

  it.each([
    ["nothing", null],
    ["a list", []],
    ["text", "models"],
    ["an object without models", { data: [] }],
    ["models that are not a list", { models: {} }],
  ])("finds no list in %s", (_case, body) => {
    expect(tiersFromModelList(body)).toBeNull();
  });
});

describe("readFastReport", () => {
  it("reads a list the extension reported", () => {
    const models = [
      { id: "gpt-6.1-sol", fast: { speed: 2, moreUsage: true } },
      { id: "gpt-6-sol", fast: { speed: 1.5, moreUsage: false } },
      { id: "gpt-5.5", fast: { speed: null, moreUsage: true } },
      { id: "gpt-5.4", fast: null },
      { id: "x".repeat(200), fast: { speed: 100, moreUsage: false } },
    ];

    expect(readFastReport(JSON.stringify({ models }))).toStrictEqual({ models });
  });

  it("reads an empty list and a failure", () => {
    expect([readFastReport('{"models":[]}'), readFastReport('{"failure":"http_401"}')]).toStrictEqual([
      { models: [] },
      { failure: "http_401" },
    ]);
  });

  it.each([
    ["nothing", undefined],
    ["text that is not JSON", "models"],
    ["JSON that is no object", "null"],
    ["a number", "5"],
    ["neither a list nor a failure", "{}"],
    ["models that are not a list", '{"models":{}}'],
    ["a failure with words", '{"failure":"Unauthorized token"}'],
    ["a failure in capitals", '{"failure":"HTTP_401"}'],
    ["an empty failure", '{"failure":""}'],
    ["a failure that is no text", '{"failure":401}'],
    ["a long failure", JSON.stringify({ failure: "x".repeat(41) })],
    [
      "too many models",
      JSON.stringify({ models: Array.from({ length: 501 }, (_, i) => ({ id: `m${String(i)}`, fast: null })) }),
    ],
    ["a model that is no object", '{"models":["gpt-5.5"]}'],
    ["a model without an id", '{"models":[{"fast":null}]}'],
    ["a model without fast", '{"models":[{"id":"gpt-5.5"}]}'],
    ["an empty id", '{"models":[{"id":"","fast":null}]}'],
    ["an id that is no text", '{"models":[{"id":5,"fast":null}]}'],
    ["a long id", JSON.stringify({ models: [{ id: "x".repeat(201), fast: null }] })],
    ["fast as a number", '{"models":[{"id":"a","fast":2.5}]}'],
    ["fast without moreUsage", '{"models":[{"id":"a","fast":{"speed":2}}]}'],
    ["fast without speed", '{"models":[{"id":"a","fast":{"moreUsage":true}}]}'],
    ["fast with more", '{"models":[{"id":"a","fast":{"speed":2,"moreUsage":true,"credits":2}}]}'],
    ["moreUsage that is no boolean", '{"models":[{"id":"a","fast":{"speed":2,"moreUsage":"yes"}}]}'],
    ["speed as text", '{"models":[{"id":"a","fast":{"speed":"2","moreUsage":true}}]}'],
    ["speed of 0", '{"models":[{"id":"a","fast":{"speed":0,"moreUsage":true}}]}'],
    ["speed over 100", '{"models":[{"id":"a","fast":{"speed":101,"moreUsage":true}}]}'],
    ["one bad model among good", '{"models":[{"id":"a","fast":null},{"id":"b"}]}'],
  ])("reads no report from %s", (_case, text) => {
    expect(readFastReport(text)).toBeNull();
  });
});
