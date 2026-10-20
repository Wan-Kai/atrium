import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Git's environment for the demo: a fixed author and none of the user's or the system's settings. */
const GIT_ENV = {
  GIT_AUTHOR_NAME: "demo",
  GIT_AUTHOR_EMAIL: "demo@example.com",
  GIT_COMMITTER_NAME: "demo",
  GIT_COMMITTER_EMAIL: "demo@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  PATH: "/usr/bin:/bin:/opt/homebrew/bin",
};

/**
 * Runs git in a directory of the demo.
 *
 * @remarks
 * The demo's history must not depend on who runs the tool, so git sees only `GIT_ENV`.
 *
 * @sideEffects Runs git, which changes the repository as `args` say.
 * @param cwd - Where to run it.
 * @param args - git's arguments.
 * @returns What git printed.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
}

/**
 * Writes files into a directory, making the folders they need.
 *
 * @remarks
 * The demo is written as text, so its files are readable here and the same on every run.
 *
 * @sideEffects Creates folders and writes files under `dir`.
 * @param dir - The directory.
 * @param files - File contents by path relative to `dir`.
 */
function put(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** `src/cache.ts` as committed: no expiry, which the story's child finds. */
const CACHE_TS = `import type { Forecast } from "./api";

/** 按城市缓存最近一次的预报。 */
const entries = new Map<string, Forecast>();

export const cache = {
  get(city: string): Forecast | undefined {
    return entries.get(city);
  },
  set(city: string, forecast: Forecast): void {
    entries.set(city, forecast);
  },
};
`;

/** `src/api.ts` as committed, before the hourly forecast. */
const API_TS = `import { cache } from "./cache";

export interface Forecast {
  city: string;
  temperature: number;
  condition: string;
  days: DailyForecast[];
}

export interface DailyForecast {
  date: string;
  high: number;
  low: number;
  condition: string;
}

const BASE = "https://api.example.com";

export async function fetchForecast(city: string): Promise<Forecast> {
  const cached = cache.get(city);
  if (cached) return cached;
  const response = await fetch(\`\${BASE}/forecast?city=\${encodeURIComponent(city)}\`);
  if (!response.ok) throw new Error(\`forecast failed: \${response.status}\`);
  const forecast = (await response.json()) as Forecast;
  cache.set(city, forecast);
  return forecast;
}
`;

/** `src/pages/home.tsx` as committed, before the hourly forecast. */
const HOME_TSX = `import { useEffect, useState } from "react";
import { type Forecast, fetchForecast } from "../api";
import { DailyList } from "../components/daily-list";

export function Home({ city }: { city: string }) {
  const [forecast, setForecast] = useState<Forecast | null>(null);

  useEffect(() => {
    void fetchForecast(city).then(setForecast);
  }, [city]);

  if (forecast === null) return <p className="loading">加载中…</p>;
  return (
    <main>
      <h1>{forecast.city}</h1>
      <p className="now">
        {Math.round(forecast.temperature)}° · {forecast.condition}
      </p>
      <DailyList days={forecast.days} />
    </main>
  );
}
`;

/** The demo's first commit. */
const FILES: Record<string, string> = {
  "package.json": `${JSON.stringify(
    {
      name: "weather-app",
      private: true,
      type: "module",
      scripts: { dev: "vite", build: "vite build", test: "vitest run" },
      dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" },
      devDependencies: { typescript: "^5.9.0", vite: "^7.1.0", vitest: "^4.0.0" },
    },
    null,
    2,
  )}\n`,
  "README.md":
    "# weather-app\n\n一个小小的天气应用：首页显示所在城市现在的天气和未来七天的预报。\n\n```sh\nnpm run dev\n```\n",
  ".gitignore": "node_modules\ndist\n",
  "index.html":
    '<!doctype html>\n<html lang="zh-CN">\n  <head>\n    <meta charset="UTF-8" />\n    <title>天气</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n',
  "src/main.tsx":
    'import { createRoot } from "react-dom/client";\nimport { Home } from "./pages/home";\nimport "./styles.css";\n\ncreateRoot(document.getElementById("root")!).render(<Home city="杭州" />);\n',
  "src/api.ts": API_TS,
  "src/cache.ts": CACHE_TS,
  "src/units.ts":
    "/** 摄氏度转华氏度。 */\nexport function toFahrenheit(celsius: number): number {\n  return (celsius * 9) / 5 + 32;\n}\n",
  "src/pages/home.tsx": HOME_TSX,
  "src/components/daily-list.tsx":
    'import type { DailyForecast } from "../api";\n\n/** 未来几天的预报，一天一行。 */\nexport function DailyList({ days }: { days: DailyForecast[] }) {\n  return (\n    <ul className="daily">\n      {days.map((day) => (\n        <li key={day.date}>\n          <span>{day.date.slice(5)}</span>\n          <span>{day.condition}</span>\n          <span>\n            {Math.round(day.low)}° / {Math.round(day.high)}°\n          </span>\n        </li>\n      ))}\n    </ul>\n  );\n}\n',
  "src/styles.css":
    ":root {\n  font-family: system-ui, sans-serif;\n  color: #1d2129;\n  background: #f5f7fa;\n}\n\nmain {\n  max-width: 480px;\n  margin: 0 auto;\n  padding: 32px 20px;\n}\n\n.now {\n  font-size: 48px;\n  margin: 8px 0 24px;\n}\n",
  "tests/api.test.ts":
    'import { afterEach, expect, it, vi } from "vitest";\nimport { fetchForecast } from "../src/api";\n\nafterEach(() => vi.unstubAllGlobals());\n\nit("returns the forecast the API sends", async () => {\n  const forecast = { city: "杭州", temperature: 21, condition: "多云", days: [] };\n  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(forecast)));\n  expect(await fetchForecast("杭州")).toEqual(forecast);\n});\n',
};

/**
 * Creates the demo project: a weather app with a local origin and two worktrees of its own.
 *
 * @remarks
 * The screenshots show a project as a user has it after a while: pushed to an origin, one
 * worktree with uncommitted changes, one with a commit ahead of `main`. The origin is a bare
 * repository beside it, so nothing leaves the machine.
 *
 * @sideEffects Creates `weather-app`, `origin.git` and `weather-app.worktrees` in `dir`; runs git.
 * @param dir - An empty directory for the demo.
 * @returns The project's folder.
 */
export function makeDemo(dir: string): string {
  const origin = join(dir, "origin.git");
  git(dir, "init", "--bare", "-b", "main", origin);
  const repo = join(dir, "weather-app");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  put(repo, FILES);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "Show today's weather and the week ahead");
  put(repo, {
    "tests/units.test.ts":
      'import { expect, it } from "vitest";\nimport { toFahrenheit } from "../src/units";\n\nit("converts 20 °C", () => expect(toFahrenheit(20)).toBe(68));\n',
  });
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "Test the unit conversion");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  git(repo, "fetch", "origin");
  const trees = join(dir, "weather-app.worktrees");
  git(repo, "worktree", "add", "-b", "atrium/unit-switch", join(trees, "unit-switch"));
  put(join(trees, "unit-switch"), {
    "src/units.ts":
      '/** 摄氏度转华氏度。 */\nexport function toFahrenheit(celsius: number): number {\n  return (celsius * 9) / 5 + 32;\n}\n\nexport type Unit = "c" | "f";\n\n/** 按选中的单位写出温度。 */\nexport function formatTemperature(celsius: number, unit: Unit): string {\n  return unit === "c" ? `${Math.round(celsius)}°C` : `${Math.round(toFahrenheit(celsius))}°F`;\n}\n',
  });
  git(repo, "worktree", "add", "-b", "atrium/dark-mode", join(trees, "dark-mode"));
  put(join(trees, "dark-mode"), {
    "src/styles.css":
      ":root {\n  font-family: system-ui, sans-serif;\n  color: #1d2129;\n  background: #f5f7fa;\n}\n\n@media (prefers-color-scheme: dark) {\n  :root {\n    color: #e5e6eb;\n    background: #17171a;\n  }\n}\n\nmain {\n  max-width: 480px;\n  margin: 0 auto;\n  padding: 32px 20px;\n}\n\n.now {\n  font-size: 48px;\n  margin: 8px 0 24px;\n}\n",
  });
  git(join(trees, "dark-mode"), "commit", "-am", "Follow the system's dark mode");
  return repo;
}
