/**
 * ============================================================================
 *  teamz tool registry — real tools agents can call from the browser.
 * ============================================================================
 *
 *  Shape ported from mem20crewz `Skills.execute`: `executeTool()` returns
 *  `{ ok, output, tool }` and errors surface in the result — they are never
 *  thrown — so the tool loop can feed a failure back to the model as an
 *  observation and let it recover. Unknown tools late-bind the same way:
 *  the registry answers "unknown tool" instead of crashing the caller.
 *
 *  Tools run in the browser with plain `fetch` against CORS-enabled, keyless
 *  public APIs (Wikipedia REST, Open-Meteo), plus a local calculator with a
 *  hand-written parser — never `eval()`. No API keys, no server, no secrets.
 */

export interface ToolResult {
  ok: boolean;
  output: string;
  tool: string;
}

export interface ToolDefinition {
  /** Stable machine id, e.g. `wikipedia`. Stored on the agent. */
  name: string;
  /** Short human label for the settings panel. */
  label: string;
  /** One line for the settings panel. */
  description: string;
  /** What the model passes as `args` — shown in the system prompt. */
  usage: string;
  /** Runs the tool. Receives the model's `args` string, returns plain text. */
  run: (args: string) => Promise<string>;
}

const registry = new Map<string, ToolDefinition>();

export function registerTool(def: ToolDefinition): void {
  registry.set(def.name, def);
}

export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

export function listTools(): ToolDefinition[] {
  return [...registry.values()];
}

/** Names of the tools an agent has enabled, filtered to registered tools. */
export function enabledToolNames(enabledTools: string[] | undefined): string[] {
  if (!enabledTools) return [];
  return enabledTools.filter((name) => registry.has(name));
}

/**
 * One-line-per-tool inventory, in the shape the model sees in its system
 * prompt. Only the tools this agent may use are listed.
 */
export function inventoryText(names: string[]): string {
  return names
    .map((name) => {
      const def = registry.get(name);
      if (!def) return null;
      return `- ${def.name}: ${def.description} Args: ${def.usage}`;
    })
    .filter((line): line is string => line !== null)
    .join('\n');
}

/**
 * Run one tool. Never throws: an unknown tool, a network failure, or a
 * tool-side error all come back as `{ ok: false, output }` so the loop can
 * feed the failure to the model as an observation.
 */
export async function executeTool(name: string, args: string): Promise<ToolResult> {
  const def = registry.get(name);
  if (!def) {
    const known = [...registry.keys()].join(', ') || 'none registered';
    return {
      ok: false,
      output: `unknown tool: ${name}. Available tools: ${known}.`,
      tool: name,
    };
  }
  try {
    const output = await def.run(args);
    return { ok: true, output, tool: name };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, output: `${name} failed: ${message}`, tool: name };
  }
}

/* ---------------------------------------------------------------------------
 * Calculator — local, no network. Small recursive-descent parser:
 * numbers, + - * / % ^, parentheses, unary minus, sqrt/abs/min/max and the
 * constants pi/e. Anything it cannot parse is an error, never a guess.
 * ------------------------------------------------------------------------- */

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'op'; value: string }
  | { kind: 'ident'; value: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'comma' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let num = '';
      while (i < input.length && ((input[i] >= '0' && input[i] <= '9') || input[i] === '.')) {
        num += input[i++];
      }
      const value = Number(num);
      if (!Number.isFinite(value)) throw new Error(`not a number: ${num}`);
      tokens.push({ kind: 'num', value });
      continue;
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
      let ident = '';
      while (i < input.length && /[a-zA-Z]/.test(input[i])) ident += input[i++];
      tokens.push({ kind: 'ident', value: ident.toLowerCase() });
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%' || ch === '^') {
      tokens.push({ kind: 'op', value: ch });
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma' });
      i++;
      continue;
    }
    throw new Error(`unexpected character: ${ch}`);
  }
  return tokens;
}

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: (x) => {
    if (x < 0) throw new Error('sqrt of a negative number');
    return Math.sqrt(x);
  },
  abs: (x) => Math.abs(x),
  min: (...xs) => Math.min(...xs),
  max: (...xs) => Math.max(...xs),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  round: (x) => Math.round(x),
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** Parse and evaluate a math expression. Throws on anything invalid. */
export function evaluateExpression(input: string): number {
  const expr = input.trim();
  if (!expr) throw new Error('empty expression');
  const tokens = tokenize(expr);
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token | undefined => tokens[pos++];

  function parseExpr(): number {
    let value = parseTerm();
    for (;;) {
      const t = peek();
      if (t?.kind === 'op' && (t.value === '+' || t.value === '-')) {
        next();
        const rhs = parseTerm();
        value = t.value === '+' ? value + rhs : value - rhs;
      } else {
        return value;
      }
    }
  }

  function parseTerm(): number {
    let value = parseFactor();
    for (;;) {
      const t = peek();
      if (t?.kind === 'op' && (t.value === '*' || t.value === '/' || t.value === '%')) {
        next();
        const rhs = parseFactor();
        if (t.value === '*') value *= rhs;
        else if (t.value === '/') {
          if (rhs === 0) throw new Error('division by zero');
          value /= rhs;
        } else {
          if (rhs === 0) throw new Error('modulo by zero');
          value %= rhs;
        }
      } else {
        return value;
      }
    }
  }

  // ^ is right-associative: 2^3^2 = 2^(3^2).
  function parseFactor(): number {
    const base = parseUnary();
    const t = peek();
    if (t?.kind === 'op' && t.value === '^') {
      next();
      return Math.pow(base, parseFactor());
    }
    return base;
  }

  function parseUnary(): number {
    const t = peek();
    if (t?.kind === 'op' && t.value === '-') {
      next();
      return -parseUnary();
    }
    if (t?.kind === 'op' && t.value === '+') {
      next();
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    const t = next();
    if (!t) throw new Error('unexpected end of expression');
    if (t.kind === 'num') return t.value;
    if (t.kind === 'lparen') {
      const value = parseExpr();
      const close = next();
      if (!close || close.kind !== 'rparen') throw new Error('missing closing parenthesis');
      return value;
    }
    if (t.kind === 'ident') {
      if (t.value in CONSTANTS && peek()?.kind !== 'lparen') return CONSTANTS[t.value];
      const fn = FUNCTIONS[t.value];
      if (!fn) throw new Error(`unknown function or constant: ${t.value}`);
      const open = next();
      if (!open || open.kind !== 'lparen') throw new Error(`expected ( after ${t.value}`);
      const args: number[] = [];
      if (peek()?.kind !== 'rparen') {
        args.push(parseExpr());
        while (peek()?.kind === 'comma') {
          next();
          args.push(parseExpr());
        }
      }
      const close = next();
      if (!close || close.kind !== 'rparen') throw new Error(`missing ) after ${t.value}(`);
      return fn(...args);
    }
    throw new Error(`unexpected token: ${t.kind}`);
  }

  const value = parseExpr();
  if (pos < tokens.length) throw new Error('trailing characters after expression');
  if (!Number.isFinite(value)) throw new Error('result is not a finite number');
  return value;
}

async function runCalculator(args: string): Promise<string> {
  const value = evaluateExpression(args);
  const shown = Number.isInteger(value) ? String(value) : String(Math.round(value * 1e10) / 1e10);
  return `${args.trim()} = ${shown}`;
}

/* ---------------------------------------------------------------------------
 * Wikipedia — keyless REST summary API, CORS-enabled.
 * Tries the query as a page title first; on a miss, falls back to the
 * OpenSearch API to find the best-matching title, then summarises that.
 * ------------------------------------------------------------------------- */

const WIKI_SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const WIKI_SEARCH = 'https://en.wikipedia.org/w/api.php';

interface WikiSummary {
  title?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
}

async function fetchWikiSummary(title: string): Promise<WikiSummary | null> {
  const res = await fetch(`${WIKI_SUMMARY}${encodeURIComponent(title)}`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Wikipedia returned ${res.status}`);
  return (await res.json()) as WikiSummary;
}

async function runWikipedia(args: string): Promise<string> {
  const query = args.trim();
  if (!query) throw new Error('wikipedia needs a search term, e.g. "Ada Lovelace"');
  let summary = await fetchWikiSummary(query);
  if (!summary) {
    const searchUrl =
      `${WIKI_SEARCH}?action=opensearch&search=${encodeURIComponent(query)}` +
      '&limit=1&namespace=0&format=json&origin=*';
    const res = await fetch(searchUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Wikipedia search returned ${res.status}`);
    const data = (await res.json()) as unknown;
    const titles = Array.isArray(data) && Array.isArray(data[1]) ? (data[1] as unknown[]) : [];
    const best = titles.find((t): t is string => typeof t === 'string');
    if (!best) return `No Wikipedia article found for "${query}".`;
    summary = await fetchWikiSummary(best);
    if (!summary) return `No Wikipedia article found for "${query}".`;
  }
  const extract = (summary.extract ?? '').trim();
  const url = summary.content_urls?.desktop?.page ?? '';
  const head = summary.title ? `${summary.title}` : query;
  const body = extract ? extract.slice(0, 1200) : 'No summary available for this article.';
  return url ? `${head}\n${body}\nRead more: ${url}` : `${head}\n${body}`;
}

/* ---------------------------------------------------------------------------
 * Weather — keyless Open-Meteo, CORS-enabled. Geocoding API turns a place
 * name into coordinates, then the forecast API returns current conditions
 * plus a 3-day outlook.
 * ------------------------------------------------------------------------- */

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const WMO_CODE: Record<number, string> = {
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'depositing rime fog',
  51: 'light drizzle',
  53: 'moderate drizzle',
  55: 'dense drizzle',
  56: 'light freezing drizzle',
  57: 'dense freezing drizzle',
  61: 'slight rain',
  63: 'moderate rain',
  65: 'heavy rain',
  66: 'light freezing rain',
  67: 'heavy freezing rain',
  71: 'slight snow',
  73: 'moderate snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'slight rain showers',
  81: 'moderate rain showers',
  82: 'violent rain showers',
  85: 'slight snow showers',
  86: 'heavy snow showers',
  95: 'thunderstorm',
  96: 'thunderstorm with slight hail',
  99: 'thunderstorm with heavy hail',
};

function describeWeather(code: number): string {
  return WMO_CODE[code] ?? `weather code ${code}`;
}

interface GeocodeHit {
  name?: string;
  country?: string;
  admin1?: string;
  latitude?: number;
  longitude?: number;
}

async function runWeather(args: string): Promise<string> {
  const place = args.trim();
  if (!place) throw new Error('weather needs a place name, e.g. "Denver"');
  const geoUrl = `${GEOCODE_URL}?name=${encodeURIComponent(place)}&count=1&language=en&format=json`;
  const geoRes = await fetch(geoUrl, { headers: { Accept: 'application/json' } });
  if (!geoRes.ok) throw new Error(`Open-Meteo geocoding returned ${geoRes.status}`);
  const geo = (await geoRes.json()) as { results?: GeocodeHit[] };
  const hit = geo.results?.[0];
  if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') {
    return `Could not find a place called "${place}".`;
  }
  const label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
  const fcUrl =
    `${FORECAST_URL}?latitude=${hit.latitude}&longitude=${hit.longitude}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    '&timezone=auto&forecast_days=3';
  const fcRes = await fetch(fcUrl, { headers: { Accept: 'application/json' } });
  if (!fcRes.ok) throw new Error(`Open-Meteo forecast returned ${fcRes.status}`);
  const fc = (await fcRes.json()) as {
    current?: {
      temperature_2m?: number;
      relative_humidity_2m?: number;
      apparent_temperature?: number;
      wind_speed_10m?: number;
      weather_code?: number;
    };
    daily?: {
      time?: string[];
      temperature_2m_max?: (number | null)[];
      temperature_2m_min?: (number | null)[];
      precipitation_probability_max?: (number | null)[];
    };
  };
  const cur = fc.current ?? {};
  const lines: string[] = [`Weather in ${label}:`];
  const now: string[] = [];
  if (typeof cur.temperature_2m === 'number') {
    now.push(
      typeof cur.apparent_temperature === 'number'
        ? `${cur.temperature_2m}°C (feels like ${cur.apparent_temperature}°C)`
        : `${cur.temperature_2m}°C`,
    );
  }
  if (typeof cur.weather_code === 'number') now.push(describeWeather(cur.weather_code));
  if (typeof cur.relative_humidity_2m === 'number') now.push(`humidity ${cur.relative_humidity_2m}%`);
  if (typeof cur.wind_speed_10m === 'number') now.push(`wind ${cur.wind_speed_10m} km/h`);
  lines.push(now.length ? `Now: ${now.join(', ')}.` : 'Current conditions unavailable.');
  const daily = fc.daily;
  const days = daily?.time ?? [];
  for (let i = 0; i < Math.min(days.length, 3); i++) {
    const hi = daily?.temperature_2m_max?.[i];
    const lo = daily?.temperature_2m_min?.[i];
    const pop = daily?.precipitation_probability_max?.[i];
    const parts: string[] = [];
    if (typeof hi === 'number' && typeof lo === 'number') parts.push(`${lo}°C – ${hi}°C`);
    if (typeof pop === 'number') parts.push(`${pop}% chance of precipitation`);
    if (parts.length) lines.push(`${days[i]}: ${parts.join(', ')}.`);
  }
  return lines.join('\n');
}

/* ---------------------------------------------------------------------------
 * Built-in tools, registered on import.
 * ------------------------------------------------------------------------- */

registerTool({
  name: 'wikipedia',
  label: 'Wikipedia',
  description: 'Look up a topic on Wikipedia and return a short summary.',
  usage: 'a search term, e.g. "Ada Lovelace"',
  run: runWikipedia,
});

registerTool({
  name: 'weather',
  label: 'Weather',
  description: 'Current weather and a 3-day outlook for any place on Earth.',
  usage: 'a place name, e.g. "Denver"',
  run: runWeather,
});

registerTool({
  name: 'calculator',
  label: 'Calculator',
  description: 'Evaluate a math expression (no network, runs locally).',
  usage: 'a math expression, e.g. "2 + 3 * 4"',
  run: runCalculator,
});
