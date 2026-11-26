import { describe, expect, it } from 'vitest';
import {
  SKILL_BUNDLES,
  bundleIsFullySelected,
  bundleIsPartiallySelected,
  expandBundle,
  expandSkillKeys,
  getBundle,
  getBundles,
  toggleBundle,
} from './bundles';
import { getSkillByKey } from './skills';

describe('skill bundles — shape', () => {
  it('declares at least one bundle per category family', () => {
    expect(SKILL_BUNDLES.length).toBeGreaterThanOrEqual(10);
  });

  it('gives every bundle a unique id and at least two member skills', () => {
    const ids = SKILL_BUNDLES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const bundle of SKILL_BUNDLES) {
      expect(bundle.name.trim().length).toBeGreaterThan(0);
      expect(bundle.description.trim().length).toBeGreaterThan(0);
      expect(bundle.skillKeys.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('resolves every member to a real registry skill with a real description', () => {
    for (const bundle of SKILL_BUNDLES) {
      const members = expandBundle(bundle);
      expect(members.length).toBe(bundle.skillKeys.length);
      for (const skill of members) {
        expect(skill.name.trim().length).toBeGreaterThan(0);
        expect(skill.description.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('has no duplicate member inside a bundle', () => {
    for (const bundle of SKILL_BUNDLES) {
      expect(new Set(bundle.skillKeys).size).toBe(bundle.skillKeys.length);
    }
  });

  it('contains the two bundles from the brief', () => {
    const review = getBundle('code-review');
    expect(review).toBeDefined();
    expect(expandBundle(review!).map((s) => s.id)).toEqual([
      'code-review',
      'testing',
      'refactoring',
    ]);

    const research = getBundle('research');
    expect(research).toBeDefined();
    expect(expandBundle(research!).map((s) => s.id)).toEqual([
      'literature-search',
      'source-evaluation',
      'synthesis',
      'citation',
      'fact-checking',
    ]);
  });
});

describe('expandSkillKeys', () => {
  it('resolves keys in order and deduplicates', () => {
    const skills = expandSkillKeys([
      'engineering.react',
      'engineering.ts',
      'engineering.react',
    ]);
    expect(skills.map((s) => s.id)).toEqual(['react', 'ts']);
  });

  it('throws on an unknown key instead of silently dropping it', () => {
    expect(() => expandSkillKeys(['engineering.nope'])).toThrow('Unknown skill key');
  });
});

describe('toggleBundle', () => {
  const review = getBundle('code-review')!;

  it('adds the missing members and keeps the existing selection', () => {
    const next = toggleBundle(review, ['research.citation']);
    expect(next).toEqual([
      'research.citation',
      'engineering.code-review',
      'engineering.testing',
      'engineering.refactoring',
    ]);
  });

  it('adds only the members that are missing', () => {
    const next = toggleBundle(review, ['engineering.testing']);
    expect(next).toEqual([
      'engineering.testing',
      'engineering.code-review',
      'engineering.refactoring',
    ]);
  });

  it('removes all members when the bundle is fully selected', () => {
    const selected = [
      'research.citation',
      'engineering.code-review',
      'engineering.testing',
      'engineering.refactoring',
    ];
    expect(toggleBundle(review, selected)).toEqual(['research.citation']);
  });

  it('round-trips: toggling twice restores the selection', () => {
    const selected = ['research.citation'];
    expect(toggleBundle(review, toggleBundle(review, selected))).toEqual(selected);
  });
});

describe('bundle selection state', () => {
  const review = getBundle('code-review')!;

  it('distinguishes full, partial and empty selection', () => {
    const full = ['engineering.code-review', 'engineering.testing', 'engineering.refactoring'];
    expect(bundleIsFullySelected(review, full)).toBe(true);
    expect(bundleIsPartiallySelected(review, full)).toBe(false);

    const partial = ['engineering.testing'];
    expect(bundleIsFullySelected(review, partial)).toBe(false);
    expect(bundleIsPartiallySelected(review, partial)).toBe(true);

    expect(bundleIsFullySelected(review, [])).toBe(false);
    expect(bundleIsPartiallySelected(review, [])).toBe(false);
  });
});

describe('getBundles', () => {
  it('exposes every bundle and resolves each member through the registry', () => {
    for (const bundle of getBundles()) {
      for (const key of bundle.skillKeys) {
        expect(getSkillByKey(key).name).toBeTruthy();
      }
    }
  });
});
