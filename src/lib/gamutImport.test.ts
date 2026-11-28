import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GamutImportError, parseFrontmatter, parseGamutAgent } from './gamutImport';
import { makeZip } from './zipFixture';

const FIXTURE = new Uint8Array(readFileSync(new URL('../../gamut-reference/company-brain.agent', import.meta.url)));

const GOOD = `---
name: Tester
description: 'Tests things, and says so'
createdAt: "2026-06-04T00:00:00.000Z"
version: 1.0.0
---

# Tester

You test things.
`;

const zipOf = (files: Array<[string, string]>) => makeZip(files.map(([path, data]) => ({ path, data })));
const fails = async (bytes: Uint8Array, re: RegExp) => {
  const err = await parseGamutAgent(bytes).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GamutImportError);
  expect((err as Error).message).toMatch(re);
};

describe('the company-brain fixture (real Gamut template content, container shape only)', () => {
  it('imports with the documented fields', async () => {
    const imp = await parseGamutAgent(FIXTURE);
    expect(imp.frontmatter.name).toBe('Company Brain');
    expect(imp.frontmatter.createdAt).toBe('2026-06-04T00:00:00.000Z');
    expect(imp.instructionsPath).toBe('CLAUDE.md');
    expect(imp.skills.map((s) => s.name)).toEqual(['agent-onboarding']);
    expect(imp.envNames).toEqual(['KNOWLEDGE_SOURCE_API_KEY']);
    expect(imp.files.map((f) => f.path).sort()).toEqual(
      ['.claude/skills/agent-onboarding/SKILL.md', '.env.example', 'CLAUDE.md', 'README.md', 'knowledge-store.json'].sort(),
    );
    expect(imp.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the instructions verbatim: 8,589 bytes, frontmatter included, body untouched', async () => {
    const imp = await parseGamutAgent(FIXTURE);
    expect(new TextEncoder().encode(imp.rawInstructions).length).toBe(8589);
    expect(imp.rawInstructions.startsWith('---\nname: Company Brain\n')).toBe(true);
    expect(imp.rawInstructions.endsWith(imp.body)).toBe(true);
    expect(imp.body.startsWith('\n# Company Brain')).toBe(true);
  });
});

describe('parseFrontmatter', () => {
  it('reads quoted and plain values', () => {
    const { fm, body } = parseFrontmatter(GOOD);
    expect(fm).toMatchObject({ name: 'Tester', description: 'Tests things, and says so', version: '1.0.0' });
    expect(body.trim().startsWith('# Tester')).toBe(true);
  });
  it('un-doubles single quotes inside single-quoted values', () => {
    expect(parseFrontmatter("---\nname: 'It''s fine'\n---\nbody").fm.name).toBe("It's fine");
  });
  it('refuses nested YAML instead of guessing', () => {
    expect(() => parseFrontmatter('---\nname: x\ntools:\n  - a\n---\nbody')).toThrow(GamutImportError);
  });
  it('refuses a file with no frontmatter', () => {
    expect(() => parseFrontmatter('# just markdown')).toThrow(/no YAML frontmatter/);
  });
});

describe('container shape', () => {
  it('accepts AGENTS.md, and prefers it over CLAUDE.md', async () => {
    const imp = await parseGamutAgent(zipOf([['CLAUDE.md', GOOD.replace('Tester', 'Old')], ['AGENTS.md', GOOD]]));
    expect(imp.instructionsPath).toBe('AGENTS.md');
    expect(imp.frontmatter.name).toBe('Tester');
  });
  it('tolerates one wrapper directory and ignores __MACOSX', async () => {
    const imp = await parseGamutAgent(zipOf([['tester/AGENTS.md', GOOD], ['tester/README.md', '# r'], ['__MACOSX/tester/._AGENTS.md', 'junk']]));
    expect(imp.frontmatter.name).toBe('Tester');
    expect(imp.files.map((f) => f.path).sort()).toEqual(['AGENTS.md', 'README.md']);
  });
  it('reads deflated and stored entries alike', async () => {
    const bytes = makeZip([{ path: 'AGENTS.md', data: GOOD, method: 0 }, { path: 'README.md', data: '# r' }]);
    expect((await parseGamutAgent(bytes)).frontmatter.name).toBe('Tester');
  });
});

describe('refuses what it does not recognise', () => {
  it('bytes that are not a ZIP', async () => fails(new TextEncoder().encode('hello world, not a zip file at all'), /Not a ZIP/));
  it('an archive with no instructions entry', async () => fails(zipOf([['README.md', '# x']]), /No CLAUDE\.md or AGENTS\.md/));
  it('missing name', async () => fails(zipOf([['AGENTS.md', GOOD.replace('name: Tester\n', '')]]), /missing `name`/));
  it('missing description', async () =>
    fails(zipOf([['AGENTS.md', GOOD.replace("description: 'Tests things, and says so'\n", '')]]), /missing `description`/));
  it('a createdAt that is not a date', async () =>
    fails(zipOf([['AGENTS.md', GOOD.replace('"2026-06-04T00:00:00.000Z"', 'someday')]]), /not a date/));
  it('an empty body', async () => fails(zipOf([['AGENTS.md', '---\nname: T\ndescription: d\n---\n\n']]), /no body/));
  it('a real .env (a Full export with secrets)', async () =>
    fails(zipOf([['AGENTS.md', GOOD], ['.env', 'API_KEY=sk-secret']]), /Teamz will not store keys/));
  it('path traversal', async () => fails(zipOf([['AGENTS.md', GOOD], ['../evil.txt', 'x']]), /Unsafe path/));
  it('an absolute path', async () => fails(zipOf([['AGENTS.md', GOOD], ['/etc/passwd', 'x']]), /Unsafe path/));
  it('an encrypted entry', async () => fails(makeZip([{ path: 'AGENTS.md', data: GOOD, flags: 1 }]), /encrypted/));
  it('an unsupported compression method', async () => fails(makeZip([{ path: 'AGENTS.md', data: GOOD, method: 9 }]), /method 9/));
  it('an entry that inflates to a different size than declared', async () =>
    fails(makeZip([{ path: 'AGENTS.md', data: GOOD, declaredSize: 5 }]), /different size|size limit/));
  it('a skill file with no name', async () =>
    fails(zipOf([['AGENTS.md', GOOD], ['.claude/skills/x/SKILL.md', '---\ndescription: d\n---\nbody']]), /no `name`/));
  it('an archive over the size limit', async () => {
    const err = await parseGamutAgent(zipOf([['AGENTS.md', GOOD]]), { maxFiles: 10, maxTotalBytes: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GamutImportError);
    expect((err as Error).message).toMatch(/larger than the import size limit/);
  });
  it('too many entries', async () => {
    const err = await parseGamutAgent(zipOf([['AGENTS.md', GOOD], ['a.md', 'a'], ['b.md', 'b']]), { maxFiles: 2, maxTotalBytes: 1e6 }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/limit is 2/);
  });
});

describe('secrets stay out', () => {
  it('reads .env.example for names only, never values', async () => {
    const imp = await parseGamutAgent(
      zipOf([['AGENTS.md', GOOD], ['.env.example', '# FOO_KEY=abc123\nBAR_TOKEN=hunter2\nnot a var']]),
    );
    expect(imp.envNames).toEqual(['FOO_KEY', 'BAR_TOKEN']);
    expect(JSON.stringify(imp)).not.toContain('hunter2');
  });
});
