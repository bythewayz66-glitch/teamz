import { useCallback, useEffect, useState } from 'react';
import {
  LIBRARY_STORAGE_KEY,
  addCustom,
  allTemplates,
  findImportBySha,
  getLibraryTemplate,
  parseLibrary,
  removeCustom,
  type LibraryState,
} from '../lib/libraryState';
import {
  publishFromAgent,
  recordReview,
  templateFromImport,
  type Bump,
  type FirstJob,
  type LibraryTemplate,
} from '../lib/library';
import { parseGamutAgent } from '../lib/gamutImport';
import type { Agent } from '../types';

const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agent';

export type ImportOutcome = { ok: true; template: LibraryTemplate } | { ok: false; reason: string };

export function useLibrary() {
  const [state, setState] = useState<LibraryState>(() => {
    try {
      return parseLibrary(localStorage.getItem(LIBRARY_STORAGE_KEY));
    } catch {
      return { custom: [] };
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(state));
    } catch {
      console.warn('[teamz] localStorage quota exceeded; the Team Library was not saved.');
    }
  }, [state]);

  const templates = allTemplates(state);

  const publish = useCallback(
    (
      agent: Agent,
      opts: { bump: Bump; note: string; existingId?: string; summary?: string; firstJob?: FirstJob | null },
    ): { ok: true; template: LibraryTemplate } | { ok: false; reason: string } => {
      try {
        const existing = opts.existingId ? getLibraryTemplate(state, opts.existingId) ?? null : null;
        const template = publishFromAgent({
          existing,
          agent,
          bump: opts.bump,
          note: opts.note,
          now: Date.now(),
          summary: opts.summary,
          firstJob: opts.firstJob,
          idFactory: (name) => `lib.${slug(name)}-${uid('p').slice(2, 7)}`,
        });
        setState((s) => addCustom(s, template));
        return { ok: true, template };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : 'Could not publish.' };
      }
    },
    [state],
  );

  const importAgentFile = useCallback(
    async (file: File): Promise<ImportOutcome> => {
      try {
        const imp = await parseGamutAgent(new Uint8Array(await file.arrayBuffer()));
        const dup = findImportBySha(state, imp.archiveSha256);
        if (dup) return { ok: false, reason: `Already imported as “${dup.name}”.` };
        const template = templateFromImport(imp, { id: uid('gamut'), filename: file.name, now: Date.now() });
        setState((s) => addCustom(s, template));
        return { ok: true, template };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : 'Could not read that file.' };
      }
    },
    [state],
  );

  const review = useCallback(
    (id: string, decision: 'approved' | 'rejected', by: string, note: string): string | null => {
      const t = getLibraryTemplate(state, id);
      if (!t) return 'No such template.';
      try {
        const next = recordReview(t, decision, by, note, Date.now());
        setState((s) => addCustom(s, next));
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : 'Could not record the decision.';
      }
    },
    [state],
  );

  const remove = useCallback((id: string) => setState((s) => removeCustom(s, id)), []);

  return { state, templates, publish, importAgentFile, review, remove };
}

export type UseLibrary = ReturnType<typeof useLibrary>;
