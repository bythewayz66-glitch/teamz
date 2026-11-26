import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const inventory = JSON.parse(readFileSync(join(ROOT, 'docs/credential-inventory.json'), 'utf-8'));

const FORBIDDEN_KEYS = new Set([
  'value',
  'secret',
  'token',
  'password',
  'apiKey',
  'api_key',
  'api-key',
  'key',
  'bearer',
  'privateKey',
]);

function walk(v: unknown, path: string, bad: string[]): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => walk(x, `${path}[${i}]`, bad));
    return;
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) bad.push(`${path}.${k}`);
      walk(val, `${path}.${k}`, bad);
    }
  }
}

describe('Keymaster — credential inventory (presence only, never values)', () => {
  it('lists all eight credentials the system needs', () => {
    const ids = inventory.credentials.map((c: { id: string }) => c.id);
    expect(ids).toEqual([
      'stripe-secret-key',
      'stripe-publishable-key',
      'github-token',
      'cloudflare-api-token',
      'pollinations-api-key',
      'ionos-credentials',
      'teamily-server-key',
      'agensi-oauth',
    ]);
  });

  it('every entry says what it is, where it lives, what needs it, and present vs missing', () => {
    for (const c of inventory.credentials) {
      expect(typeof c.what).toBe('string');
      expect(c.what.length).toBeGreaterThan(5);
      expect(typeof c.livesAt).toBe('string');
      expect(c.livesAt.length).toBeGreaterThan(5);
      expect(typeof c.neededBy).toBe('string');
      expect(c.neededBy.length).toBeGreaterThan(5);
      expect(['present', 'missing', 'missing-on-jnet1']).toContain(c.status);
    }
  });

  it('contains no credential value anywhere — no forbidden key, no key-shaped string', () => {
    const bad: string[] = [];
    walk(inventory, 'inventory', bad);
    expect(bad).toEqual([]);
    const raw = JSON.stringify(inventory);
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(raw).not.toMatch(/gho_[A-Za-z0-9]/);
    expect(raw).not.toMatch(/xox[baprs]-[A-Za-z0-9-]/);
    expect(raw).not.toMatch(/Bearer [A-Za-z0-9]/);
  });

  it('the missing summary matches the entries marked missing', () => {
    const missing = inventory.credentials
      .filter((c: { status: string }) => c.status === 'missing')
      .map((c: { id: string }) => c.id);
    expect(inventory.missingSummary).toEqual(missing);
  });

  it('records the secrets store as existing, restricted, and unpopulated', () => {
    expect(inventory.secretsStore.path).toBe('/var/lib/teamz-secrets');
    expect(inventory.secretsStore.permissions).toContain('0700');
    expect(inventory.secretsStore.permissions).toContain('teamz');
    expect(inventory.secretsStore.populated).toBe(false);
  });

  it('names the still-missing credentials plainly', () => {
    expect(inventory.missingSummary).toContain('stripe-secret-key');
    expect(inventory.missingSummary).toContain('pollinations-api-key');
    expect(inventory.missingSummary).toContain('teamily-server-key');
  });
});
