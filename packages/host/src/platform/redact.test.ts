import { describe, expect, it } from "vitest";
import { createRedactor, secretsInEnvironment } from "./redact";

const redact = createRedactor(() => ["s3cr3t-token-value"]);

describe("createRedactor", () => {
  it.each([
    "token",
    "access_token",
    "accessToken",
    "refresh_token",
    "refreshToken",
    "id_token",
    "idToken",
    "auth_token",
    "authToken",
    "session_token",
    "sessionToken",
    "bearer",
    "private_key",
    "privateKey",
    "x-api-key",
    "api-key",
    "proxy-authorization",
    "secret",
    "client_secret",
    "clientSecret",
    "password",
    "passwd",
    "api_key",
    "apiKey",
    "Authorization",
    "cookie",
    "set-cookie",
    "credential",
    "credentials",
  ])("replaces the value under %s", (key) => {
    expect(redact({ [key]: "value" })).toStrictEqual({ [key]: "[redacted]" });
  });

  it("keeps keys that only look like credentials", () => {
    expect(redact({ tokens: 1200, tokenCount: 3, mytoken: "kept", secretive: "kept" })).toStrictEqual({
      tokens: 1200,
      tokenCount: 3,
      mytoken: "kept",
      secretive: "kept",
    });
  });

  it("redacts inside nested objects and arrays", () => {
    expect(redact({ nested: { list: [{ apiKey: "y" }, "plain"] } })).toStrictEqual({
      nested: { list: [{ apiKey: "[redacted]" }, "plain"] },
    });
  });

  it("passes through null, undefined, booleans and numbers", () => {
    expect(redact({ a: null, b: undefined, c: true, d: 0, e: [null] })).toStrictEqual({
      a: null,
      b: undefined,
      c: true,
      d: 0,
      e: [null],
    });
  });

  it("scrubs a known secret from strings under any key, including error messages and keys", () => {
    const error = new Error("rejected s3cr3t-token-value from client");
    expect(
      redact({ msg: "got s3cr3t-token-value twice: s3cr3t-token-value", err: error, "s3cr3t-token-value": 1 }),
    ).toStrictEqual({
      msg: "got [redacted] twice: [redacted]",
      err: { name: "Error", message: "rejected [redacted] from client", stack: expect.not.stringContaining("s3cr3t") },
      "[redacted]": 1,
    });
  });

  it("scrubs secrets of exactly the minimum length and ignores shorter ones", () => {
    expect(createRedactor(() => ["12345678"])({ msg: "a 12345678 b" })).toStrictEqual({ msg: "a [redacted] b" });
    expect(createRedactor(() => ["1234567"])({ msg: "a 1234567 b" })).toStrictEqual({ msg: "a 1234567 b" });
  });

  it("drops a string whose replacements keep forming the secret again", () => {
    expect(createRedactor(() => ["acted]ab"])({ msg: `acted]ab${"ab".repeat(6)}` })).toStrictEqual({
      msg: "[redacted]",
    });
  });

  it("marks cycles but copies an object that is merely shared twice", () => {
    const shared = { name: "shared" };
    const looped: Record<string, unknown> = { name: "loop" };
    looped["self"] = looped;

    expect(redact({ first: shared, second: shared, looped })).toStrictEqual({
      first: { name: "shared" },
      second: { name: "shared" },
      looped: { name: "loop", self: "[circular]" },
    });
  });

  it("truncates nesting deeper than twelve levels", () => {
    let twelve: unknown = { leaf: true };
    let eleven: unknown = { leaf: true };
    for (let level = 0; level < 12; level++) twelve = [twelve];
    for (let level = 0; level < 11; level++) eleven = [eleven];

    expect(redact(twelve)).toStrictEqual([[[[[[[[[[[["[truncated]"]]]]]]]]]]]]);
    expect(redact(eleven)).toStrictEqual([[[[[[[[[[[{ leaf: true }]]]]]]]]]]]);
  });

  it("truncates objects nested deeper than twelve levels", () => {
    let nested: unknown = { leaf: true };
    for (let level = 0; level < 12; level++) nested = { child: nested };

    let expected: unknown = "[truncated]";
    for (let level = 0; level < 12; level++) expected = { child: expected };
    expect(redact(nested)).toStrictEqual(expected);
  });
});

describe("secretsInEnvironment", () => {
  it("picks the values of credential-like variables long enough to matter", () => {
    expect(
      secretsInEnvironment({
        OPENAI_API_KEY: "sk-0123456789",
        GITHUB_TOKEN: "ghp_0123456789",
        DB_PASSWORD: "hunter2hunter2",
        AWS_SECRET_ACCESS_KEY: "aws-secret-1234",
        NPM_AUTH: "npm-auth-1234",
        SHORT_TOKEN: "abc",
        EIGHT_TOKEN: "12345678",
        SEVEN_TOKEN: "1234567",
        HOME: "/Users/someone",
        UNSET_KEY: undefined,
      }),
    ).toStrictEqual([
      "sk-0123456789",
      "ghp_0123456789",
      "hunter2hunter2",
      "aws-secret-1234",
      "npm-auth-1234",
      "12345678",
    ]);
  });
});
