/**
 * The skill side of the Team Library: the 15 bundles over the 135-skill
 * registry, each with a release history. A release records the bundle's member
 * skills and a fingerprint of everything a user would read (names, descriptions,
 * membership). A test fails if the live content no longer matches the newest
 * release, so a change to a skill cannot ship without a new version entry.
 */

import { SKILL_BUNDLES } from '../data/templates/bundles';
import { getSkillByKey } from '../data/templates/skills';
import { BUNDLE_RELEASES, type BundleRelease } from '../data/library/bundleReleases';
import { fingerprint } from './library';
import type { SkillBundle } from '../types';

export function bundleSnapshot(bundle: SkillBundle) {
  return {
    id: bundle.id,
    name: bundle.name,
    description: bundle.description,
    skills: bundle.skillKeys.map((key) => {
      const s = getSkillByKey(key);
      return { key, name: s.name, description: s.description };
    }),
  };
}

export const bundleFingerprint = (bundle: SkillBundle): string => fingerprint(bundleSnapshot(bundle));

export interface LibraryBundle {
  bundle: SkillBundle;
  releases: BundleRelease[];
  current: BundleRelease;
  /** True when the live content differs from the newest release. */
  drifted: boolean;
}

export function getLibraryBundles(): LibraryBundle[] {
  return SKILL_BUNDLES.map((bundle) => {
    const releases = BUNDLE_RELEASES[bundle.id] ?? [];
    if (releases.length === 0) throw new Error(`Bundle ${bundle.id} has no release recorded.`);
    const current = releases[releases.length - 1];
    return { bundle, releases, current, drifted: current.fingerprint !== bundleFingerprint(bundle) };
  });
}

export interface BundleDiff {
  from: string;
  to: string;
  addedSkills: string[];
  removedSkills: string[];
  /** Same members, different wording somewhere (fingerprints differ). */
  wordingChanged: boolean;
}

export function diffBundleReleases(a: BundleRelease, b: BundleRelease): BundleDiff {
  const before = new Set(a.skillKeys);
  const after = new Set(b.skillKeys);
  const addedSkills = b.skillKeys.filter((k) => !before.has(k));
  const removedSkills = a.skillKeys.filter((k) => !after.has(k));
  return {
    from: a.version,
    to: b.version,
    addedSkills,
    removedSkills,
    wordingChanged: addedSkills.length === 0 && removedSkills.length === 0 && a.fingerprint !== b.fingerprint,
  };
}
