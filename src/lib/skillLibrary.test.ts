import { describe, expect, it } from 'vitest';
import { SKILL_BUNDLES } from '../data/templates/bundles';
import { getAllSkills } from '../data/templates/skills';
import { BUNDLE_RELEASES } from '../data/library/bundleReleases';
import { AVATAR_SHAPES, WIDE_ACCENTS, WIDE_EMOJIS } from '../data/avatars';
import { bundleFingerprint, diffBundleReleases, getLibraryBundles } from './skillLibrary';

describe('skill library', () => {
  it('versions all 15 bundles over the 135-skill registry', () => {
    expect(SKILL_BUNDLES).toHaveLength(15);
    expect(getAllSkills()).toHaveLength(135);
    expect(Object.keys(BUNDLE_RELEASES).sort()).toEqual(SKILL_BUNDLES.map((b) => b.id).sort());
  });

  it('every bundle matches its newest release: a changed skill needs a new version entry', () => {
    for (const lb of getLibraryBundles()) {
      expect(lb.current.fingerprint, `${lb.bundle.id} changed without a new release`).toBe(bundleFingerprint(lb.bundle));
      expect(lb.drifted).toBe(false);
      expect(lb.current.skillKeys).toEqual(lb.bundle.skillKeys);
      for (const r of lb.releases) expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('notices when a bundle changes', () => {
    const b = SKILL_BUNDLES[0];
    expect(bundleFingerprint({ ...b, description: `${b.description} (edited)` })).not.toBe(bundleFingerprint(b));
    expect(bundleFingerprint({ ...b, skillKeys: b.skillKeys.slice(1) })).not.toBe(bundleFingerprint(b));
  });

  it('diffs two releases by membership and wording', () => {
    const a = { version: '1.0.0', released: 'x', note: '', skillKeys: ['a.b', 'a.c'], fingerprint: '1' };
    const b = { version: '1.1.0', released: 'y', note: '', skillKeys: ['a.c', 'a.d'], fingerprint: '2' };
    expect(diffBundleReleases(a, b)).toEqual({ from: '1.0.0', to: '1.1.0', addedSkills: ['a.d'], removedSkills: ['a.b'], wordingChanged: false });
    expect(diffBundleReleases(a, { ...a, version: '1.0.1', fingerprint: '9' }).wordingChanged).toBe(true);
  });
});

describe('avatar palettes', () => {
  it('offers eight shapes and generous, unique palettes', () => {
    expect(new Set(AVATAR_SHAPES.map((s) => s.id)).size).toBe(8);
    for (const s of AVATAR_SHAPES) expect(Boolean(s.radius) !== Boolean(s.clip)).toBe(true);
    expect(new Set(WIDE_ACCENTS).size).toBe(WIDE_ACCENTS.length);
    expect(WIDE_ACCENTS.length).toBeGreaterThanOrEqual(24);
    for (const c of WIDE_ACCENTS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(WIDE_EMOJIS).size).toBe(WIDE_EMOJIS.length);
    expect(WIDE_EMOJIS.length).toBeGreaterThanOrEqual(40);
  });
});
