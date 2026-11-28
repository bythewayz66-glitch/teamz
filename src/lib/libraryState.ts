/** Persisted part of the Team Library: what the user published or imported. Seeds ship in code. */

import { LIBRARY_SEEDS } from '../data/library/seeds.generated';
import { templateFromSeed, type LibraryTemplate } from './library';

export const LIBRARY_STORAGE_KEY = 'teamz:library:v1';

export interface LibraryState {
  /** Published and imported templates, in the order they arrived. */
  custom: LibraryTemplate[];
}

export const emptyLibrary = (): LibraryState => ({ custom: [] });

export const SEED_TEMPLATES: LibraryTemplate[] = LIBRARY_SEEDS.map(templateFromSeed);

export const allTemplates = (s: LibraryState): LibraryTemplate[] => [...SEED_TEMPLATES, ...s.custom];

export function getLibraryTemplate(s: LibraryState, id: string): LibraryTemplate | undefined {
  return allTemplates(s).find((t) => t.id === id);
}

function isTemplate(v: unknown): v is LibraryTemplate {
  const t = v as LibraryTemplate;
  return (
    !!t &&
    typeof t.id === 'string' &&
    typeof t.name === 'string' &&
    Array.isArray(t.versions) &&
    t.versions.length > 0 &&
    t.versions.every((x) => typeof x?.version === 'string' && typeof x?.content?.systemPrompt === 'string') &&
    !!t.source &&
    !!t.review &&
    ['unreviewed', 'approved', 'rejected'].includes(t.review.status)
  );
}

/** A custom template can never claim to be built in; anything malformed is dropped. */
export function parseLibrary(raw: string | null): LibraryState {
  if (!raw) return emptyLibrary();
  try {
    const parsed = JSON.parse(raw) as { custom?: unknown };
    const custom = Array.isArray(parsed.custom) ? parsed.custom.filter(isTemplate) : [];
    return { custom };
  } catch {
    return emptyLibrary();
  }
}

export function addCustom(s: LibraryState, t: LibraryTemplate): LibraryState {
  if (s.custom.some((c) => c.id === t.id)) {
    return { custom: s.custom.map((c) => (c.id === t.id ? t : c)) };
  }
  return { custom: [...s.custom, t] };
}

export function removeCustom(s: LibraryState, id: string): LibraryState {
  return { custom: s.custom.filter((c) => c.id !== id) };
}

/** An archive already in the library (same bytes) is not added twice. */
export function findImportBySha(s: LibraryState, sha: string): LibraryTemplate | undefined {
  return s.custom.find((c) => c.source.kind === 'gamut-import' && c.source.archiveSha256 === sha);
}
