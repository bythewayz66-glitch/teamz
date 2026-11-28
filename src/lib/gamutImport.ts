/**
 * Verbatim Gamut `.agent` import.
 *
 * What is built here is exactly what the Gamut importer is documented to
 * accept (see gamut-reference/README.md): a ZIP whose root holds the
 * instructions entry `CLAUDE.md` (legacy) or `AGENTS.md`, YAML frontmatter
 * with `name`, `description` and `createdAt`, then the Markdown instructions.
 * A single wrapper directory is tolerated, `__MACOSX/` is ignored, path
 * traversal is refused.
 *
 * UNVERIFIED against a real export: the only archive available is a template
 * packaged in that container shape, not one made by Gamut's Export button.
 * Anything that does not match is refused with a reason; nothing is guessed.
 *
 * Imports never hold secrets: an archive that carries a real `.env` is refused
 * (that is what a Full export would add), and `.env.example` is read for
 * variable NAMES only.
 */

import { readZip, ZipError, type ZipEntry, type ZipLimits } from './zip';

export class GamutImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GamutImportError';
  }
}

export interface GamutFrontmatter {
  name: string;
  description: string;
  createdAt?: string;
  version?: string;
  /** Any other keys, kept as written and never interpreted. */
  extra: Record<string, string>;
}

export interface GamutSkillRef {
  path: string;
  name: string;
  description: string;
}

export interface GamutImport {
  frontmatter: GamutFrontmatter;
  /** Instructions entry exactly as it was in the archive (frontmatter included). */
  rawInstructions: string;
  /** The Markdown after the frontmatter: what Gamut uses as the system prompt. */
  body: string;
  instructionsPath: 'CLAUDE.md' | 'AGENTS.md';
  skills: GamutSkillRef[];
  envNames: string[];
  files: Array<{ path: string; bytes: number }>;
  /** SHA-256 of the archive bytes, so a re-import is recognisable. */
  archiveSha256: string;
}

const MAX_NAME = 120;

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

/** Parses the flat `key: value` frontmatter Gamut templates use; nested YAML is refused. */
export function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const src = text.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) throw new GamutImportError('The instructions file has no YAML frontmatter (--- … ---).');
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (!kv) throw new GamutImportError(`Unsupported frontmatter line: "${line.slice(0, 60)}".`);
    fm[kv[1]] = unquote(kv[2] ?? '');
  }
  return { fm, body: src.slice(m[0].length) };
}

function safePath(raw: string): string {
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some((s) => s === '..')) {
    throw new GamutImportError(`Unsafe path in archive: ${raw}`);
  }
  return p;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function parseGamutAgent(bytes: Uint8Array, limits?: ZipLimits): Promise<GamutImport> {
  let entries: ZipEntry[];
  try {
    entries = await readZip(bytes, limits);
  } catch (e) {
    if (e instanceof ZipError) throw new GamutImportError(e.message);
    throw e;
  }
  entries = entries
    .map((e) => ({ ...e, path: safePath(e.path) }))
    .filter((e) => !e.path.startsWith('__MACOSX/') && !e.path.split('/').pop()!.startsWith('._'));
  if (entries.length === 0) throw new GamutImportError('The archive is empty.');

  // Tolerate exactly one wrapper directory around everything.
  const tops = new Set(entries.map((e) => e.path.split('/')[0]));
  const wrapped = tops.size === 1 && entries.every((e) => e.path.includes('/'));
  const prefix = wrapped ? `${[...tops][0]}/` : '';
  const files = entries.map((e) => ({ path: e.path.slice(prefix.length), data: e.data }));

  const instructions =
    files.find((f) => f.path === 'AGENTS.md') ?? files.find((f) => f.path === 'CLAUDE.md');
  if (!instructions) {
    throw new GamutImportError('No CLAUDE.md or AGENTS.md at the root: this is not a Gamut agent archive.');
  }
  if (files.some((f) => f.path === '.env')) {
    throw new GamutImportError(
      'The archive contains a .env file (a Full export with secrets). Export it in template mode; Teamz will not store keys.',
    );
  }

  const rawInstructions = new TextDecoder('utf-8', { fatal: true }).decode(instructions.data);
  const { fm, body } = parseFrontmatter(rawInstructions);
  const name = fm.name?.trim();
  const description = fm.description?.trim();
  if (!name) throw new GamutImportError('Frontmatter is missing `name`.');
  if (name.length > MAX_NAME) throw new GamutImportError('Frontmatter `name` is too long.');
  if (!description) throw new GamutImportError('Frontmatter is missing `description`.');
  if (fm.createdAt !== undefined && Number.isNaN(Date.parse(fm.createdAt))) {
    throw new GamutImportError('Frontmatter `createdAt` is not a date.');
  }
  if (!body.trim()) throw new GamutImportError('The instructions have no body after the frontmatter.');

  const { name: _n, description: _d, createdAt, version, ...extra } = fm;
  void _n;
  void _d;

  const skills: GamutSkillRef[] = [];
  for (const f of files) {
    if (!/^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(f.path)) continue;
    const s = parseFrontmatter(new TextDecoder().decode(f.data)).fm;
    if (!s.name?.trim()) throw new GamutImportError(`${f.path} has no \`name\` in its frontmatter.`);
    skills.push({ path: f.path, name: s.name.trim(), description: (s.description ?? '').trim() });
  }

  const envExample = files.find((f) => f.path === '.env.example');
  const envNames = envExample
    ? [
        ...new Set(
          new TextDecoder()
            .decode(envExample.data)
            .split(/\r?\n/)
            .map((l) => /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(l)?.[1])
            .filter((v): v is string => Boolean(v)),
        ),
      ]
    : [];

  return {
    frontmatter: { name, description, createdAt, version, extra },
    rawInstructions,
    body,
    instructionsPath: instructions.path as 'CLAUDE.md' | 'AGENTS.md',
    skills,
    envNames,
    files: files.map((f) => ({ path: f.path, bytes: f.data.byteLength })),
    archiveSha256: await sha256Hex(bytes),
  };
}
