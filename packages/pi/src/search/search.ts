/** DeepSeek's Search API: where the extension sends `web_search` (ADR-0014; fixed, never from a model or a login). */
export const SEARCH_URL = "https://api.deepseek.com/v1/tools/search";

/** DeepSeek's Fetch API: where the extension sends `web_fetch` (ADR-0014). */
export const FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";

/**
 * The name the search key goes by, in the environment or in a pi credential's `env` (ADR-0014).
 *
 * @remarks
 * Its own name, not pi's `deepseek` key or `DEEPSEEK_API_KEY`: the chat and the search are billed
 * apart, so the key for one is never taken for the other.
 */
export const SEARCH_KEY_ENV = "DEEPSEEK_SEARCH_API_KEY";

/** The provider in pi whose `auth.json` credential may carry the search key in its `env` (ADR-0014). */
export const SEARCH_CREDENTIAL = "deepseek";

/** The most characters of a fetched page given to the model; the rest is cut and said so. */
export const FETCH_TEXT_LIMIT = 60_000;

/** The longest address Fetch takes, in characters (DeepSeek's guide). */
export const URL_LIMIT = 8192;

/** One search result, as far as the model and the transcript use it. */
export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly site: string | null;
  /** The publication date as the API gave it (RFC 3339), or `null`. */
  readonly date: string | null;
  /** The long summary the API writes for a model to read. */
  readonly summary: string;
}

/** A fetched page. */
export interface FetchedPage {
  readonly title: string;
  readonly content: string;
}

/**
 * Whether a value is a plain object.
 *
 * @remarks
 * The API's answers are untrusted JSON, read field by field.
 *
 * @sideEffects none
 * @param value - The value.
 * @returns Whether it is one.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A string or `null` from a field the API may leave out or null.
 *
 * @remarks
 * An empty string reads as absent, so it never prints as an empty line.
 *
 * @sideEffects none
 * @param value - The field.
 * @returns The string, or `null` when it is anything else or empty.
 */
function optionalText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Reads the answer of the Search API.
 *
 * @remarks
 * A result without a title and an address is dropped, not a reason to lose the others; an answer
 * without a `results` array is not the API's (the caller reports `unknown_shape`).
 *
 * @sideEffects none
 * @param body - The parsed JSON.
 * @returns The results in the API's order, or `null` when it is not a search answer.
 */
export function readSearch(body: unknown): SearchHit[] | null {
  if (!isRecord(body) || !Array.isArray(body["results"])) return null;
  const hits: SearchHit[] = [];
  for (const item of body["results"] as unknown[]) {
    if (!isRecord(item)) continue;
    const title = optionalText(item["title"]);
    const url = optionalText(item["url"]);
    if (title === null || url === null) continue;
    hits.push({
      title,
      url,
      site: optionalText(item["site_name"]),
      date: optionalText(item["date"]),
      summary: optionalText(item["summary"]) ?? optionalText(item["snippet"]) ?? "",
    });
  }
  return hits;
}

/**
 * Reads the answer of the Fetch API.
 *
 * @remarks
 * A missing title is empty, not a failure; only an answer without `content` is not the API's.
 *
 * @sideEffects none
 * @param body - The parsed JSON.
 * @returns The page, or `null` when it is not a fetch answer.
 */
export function readFetch(body: unknown): FetchedPage | null {
  if (!isRecord(body) || typeof body["content"] !== "string") return null;
  return { title: typeof body["title"] === "string" ? body["title"] : "", content: body["content"] };
}

/**
 * The search results as text for the model.
 *
 * @remarks
 * One numbered block per result: title, address, site and day, then the summary. The `snippet`
 * is for a screen and the full `content` is never asked for; the model reads a page with `web_fetch`.
 * No results is an answer, not a failure.
 *
 * @sideEffects none
 * @param query - What was searched.
 * @param hits - The results.
 * @returns The text.
 */
export function searchText(query: string, hits: readonly SearchHit[]): string {
  if (hits.length === 0) return `No results for "${query}".`;
  const blocks = hits.map((hit, index) => {
    const where = [hit.site, hit.date === null ? null : hit.date.slice(0, 10)].filter((part) => part !== null);
    return [
      `${String(index + 1)}. ${hit.title}`,
      hit.url,
      ...(where.length > 0 ? [where.join(" · ")] : []),
      hit.summary,
    ]
      .filter((line) => line !== "")
      .join("\n");
  });
  return `Web search results for "${query}" (${String(hits.length)}):\n\n${blocks.join("\n\n")}`;
}

/**
 * A fetched page as text for the model, cut when long.
 *
 * @remarks
 * The cut never leaves half of a surrogate pair, and says how much was left out.
 *
 * @sideEffects none
 * @param page - The page.
 * @returns The text.
 */
export function fetchText(page: FetchedPage): string {
  const head = page.title === "" ? "" : `# ${page.title}\n\n`;
  if (page.content.length <= FETCH_TEXT_LIMIT) return head + page.content;
  let end = FETCH_TEXT_LIMIT;
  const last = page.content.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  const left = page.content.length - end;
  return `${head}${page.content.slice(0, end)}\n\n[Cut: ${String(left)} more characters of this page were left out.]`;
}

/**
 * Whether an address is one `web_fetch` may ask for: http or https, a host, no user name or password.
 *
 * @remarks
 * DeepSeek's rule (its guide), checked here to spare a failed request.
 *
 * @sideEffects none
 * @param address - The address.
 * @returns Whether it is.
 */
export function isFetchable(address: string): boolean {
  if (address.length > URL_LIMIT) return false;
  try {
    const parsed = new URL(address);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname !== "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

/**
 * What the model is told when a tool fails: what happened and what to do, never the server's words.
 *
 * @remarks
 * The Search API's 401 repeats the key it was sent, so no text of the server's reaches the model
 * or a log (ADR-0014, point 4); the code is all there is.
 *
 * @sideEffects none
 * @param tool - The tool that failed.
 * @param code - The failure: `no_key`, `bad_url`, `aborted`, `unreachable`, `not_json`, `unknown_shape` or `http_<status>`.
 * @returns The text.
 */
export function failureText(tool: "web_search" | "web_fetch", code: string): string {
  const what = `${tool} failed (${code}): `;
  switch (code) {
    case "no_key":
      return `${what}there is no search key. Tell the user to set DEEPSEEK_SEARCH_API_KEY (a DeepSeek API key kept for search) in their shell profile, or in the env of the deepseek entry in pi's auth.json, and restart Atrium; do not try again.`;
    case "bad_url":
      return `${what}the address must be an http or https address of at most 8192 characters, without a user name or password.`;
    case "aborted":
      return `${what}the call was stopped.`;
    case "http_401":
      return `${what}the DeepSeek login is not accepted. Tell the user to check it in Atrium's settings; do not try again.`;
    case "http_402":
      return `${what}the DeepSeek account has no balance left. Tell the user; do not try again.`;
    case "http_403":
    case "http_404":
      return `${what}this page cannot be fetched (unavailable, blocked, or nothing to read). Try another source.`;
    case "http_429":
      return `${what}too many requests. Wait a little, then try again once.`;
    case "http_400":
      return `${what}the request was not accepted; check the parameters (a query is 1 to 128 characters).`;
    default:
      return `${what}the service did not answer usefully. You may try once more later, or go on without it.`;
  }
}
