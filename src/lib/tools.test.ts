import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateExpression,
  executeTool,
  inventoryText,
  listTools,
  registerTool,
} from './tools';

describe('evaluateExpression', () => {
  it.each([
    ['2 + 3 * 4', 14],
    ['(2 + 3) * 4', 20],
    ['10 / 4', 2.5],
    ['2^3^2', 512], // ^ is right-associative
    ['-5 + 3', -2],
    ['sqrt(16) + 1', 5],
    ['abs(0 - 7)', 7],
    ['min(3, 1, 2)', 1],
    ['max(3, 1, 2)', 3],
    ['pi * 2', Math.PI * 2],
    ['10 % 3', 1],
  ])('evaluates %s = %s', (expr, expected) => {
    expect(evaluateExpression(expr)).toBeCloseTo(expected, 10);
  });

  it.each([
    ['1 / 0', 'division by zero'],
    ['1 % 0', 'modulo by zero'],
    ['sqrt(-1)', 'sqrt of a negative number'],
    ['foo(1)', 'unknown function'],
    ['2 +', 'unexpected end'],
    ['(2 + 3', 'missing closing parenthesis'],
    ['2 3', 'trailing characters'],
    ['', 'empty expression'],
    ['process.exit()', 'unexpected character'],
  ])('rejects %s (%s)', (expr) => {
    expect(() => evaluateExpression(expr)).toThrow();
  });
});

describe('executeTool', () => {
  it('runs the calculator and returns its result', async () => {
    const result = await executeTool('calculator', '2 + 3 * 4');
    expect(result).toEqual({ ok: true, output: '2 + 3 * 4 = 14', tool: 'calculator' });
  });

  it('surfaces a calculator error instead of throwing', async () => {
    const result = await executeTool('calculator', '1 / 0');
    expect(result.ok).toBe(false);
    expect(result.tool).toBe('calculator');
    expect(result.output).toContain('division by zero');
  });

  it('reports an unknown tool instead of throwing', async () => {
    const result = await executeTool('nope', 'x');
    expect(result.ok).toBe(false);
    expect(result.output).toContain('unknown tool: nope');
    expect(result.output).toContain('wikipedia');
  });

  it('surfaces a throwing tool as a failed result', async () => {
    registerTool({
      name: 'boom',
      label: 'Boom',
      description: 'Always fails.',
      usage: 'anything',
      run: async () => {
        throw new Error('kaboom');
      },
    });
    const result = await executeTool('boom', '');
    expect(result).toEqual({ ok: false, output: 'boom failed: kaboom', tool: 'boom' });
  });
});

describe('tool inventory', () => {
  it('registers the three built-in tools', () => {
    expect(listTools().map((t) => t.name)).toEqual(
      expect.arrayContaining(['wikipedia', 'weather', 'calculator']),
    );
  });

  it('describes only the enabled tools', () => {
    const text = inventoryText(['calculator']);
    expect(text).toContain('calculator');
    expect(text).not.toContain('wikipedia');
    expect(text).toContain('math expression');
  });
});

describe('wikipedia + weather (stubbed fetch, real response shapes)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('wikipedia returns the article summary', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain('en.wikipedia.org/api/rest_v1/page/summary/Ada%20Lovelace');
      return jsonResponse({
        title: 'Ada Lovelace',
        extract: 'Augusta Ada King, Countess of Lovelace, was an English mathematician.',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Ada_Lovelace' } },
      });
    }) as unknown as typeof fetch;
    const result = await executeTool('wikipedia', 'Ada Lovelace');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Ada Lovelace');
    expect(result.output).toContain('English mathematician');
    expect(result.output).toContain('https://en.wikipedia.org/wiki/Ada_Lovelace');
  });

  it('wikipedia falls back to search when the title misses', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      if (String(url).includes('opensearch')) {
        return jsonResponse(['ada', ['Ada Lovelace'], [], []]);
      }
      if (String(url).includes('Ada%20Lovelace')) {
        return jsonResponse({
          title: 'Ada Lovelace',
          extract: 'English mathematician.',
          content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Ada_Lovelace' } },
        });
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;
    const result = await executeTool('wikipedia', 'ada lovelace the mathematician');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Ada Lovelace');
    expect(calls.some((c) => c.includes('opensearch'))).toBe(true);
  });

  it('wikipedia says so when nothing matches', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      if (String(url).includes('opensearch')) return jsonResponse(['zzz', [], [], []]);
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;
    const result = await executeTool('wikipedia', 'zzzqqq');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('No Wikipedia article found');
  });

  it('weather geocodes then forecasts', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('geocoding-api.open-meteo.com')) {
        expect(u).toContain('name=Denver');
        return jsonResponse({
          results: [
            { name: 'Denver', admin1: 'Colorado', country: 'United States', latitude: 39.74, longitude: -104.99 },
          ],
        });
      }
      expect(u).toContain('latitude=39.74');
      expect(u).toContain('longitude=-104.99');
      return jsonResponse({
        current: {
          temperature_2m: 18,
          relative_humidity_2m: 30,
          apparent_temperature: 17,
          wind_speed_10m: 12,
          weather_code: 1,
        },
        daily: {
          time: ['2026-11-25', '2026-11-26', '2026-11-27'],
          temperature_2m_max: [22, 20, 19],
          temperature_2m_min: [5, 4, 3],
          precipitation_probability_max: [10, 20, 0],
        },
      });
    }) as unknown as typeof fetch;
    const result = await executeTool('weather', 'Denver');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Denver, Colorado, United States');
    expect(result.output).toContain('18°C');
    expect(result.output).toContain('mainly clear');
    expect(result.output).toContain('2026-11-25: 5°C – 22°C, 10% chance of precipitation.');
  });

  it('weather says so for an unknown place', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ results: [] }),
    ) as unknown as typeof fetch;
    const result = await executeTool('weather', 'Nowhereville');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Could not find a place called "Nowhereville"');
  });
});
