export interface BundleRelease {
  version: string;
  released: string;
  note: string;
  skillKeys: string[];
  /** Change detector over the bundle's names, descriptions and members (see lib/skillLibrary). */
  fingerprint: string;
}

const NOTE = 'First library release: the bundle as it shipped in the guided creation flow.';

/**
 * One entry per bundle, oldest first. Changing a skill or bundle means adding a
 * release here with a new version and a note; skillLibrary.test.ts fails otherwise.
 */
export const BUNDLE_RELEASES: Record<string, BundleRelease[]> = {
  "code-review": [{ version: "1.0.0", released: "2026-11-28", note: NOTE, skillKeys: ["engineering.code-review", "engineering.testing", "engineering.refactoring"], fingerprint: "846a05db" }],
  "research": [{ version: "1.0.0", released: "2026-11-28", note: NOTE, skillKeys: ["research.literature-search", "research.source-evaluation", "research.synthesis", "research.citation", "research.fact-checking"], fingerprint: "a1e24e0e" }],
  "writing": [{ version: "1.0.0", released: "2026-11-28", note: NOTE, skillKeys: ["creative.editing", "creative.storytelling", "marketing.copywriting", "creative.scripting"], fingerprint: "187d45c8" }],
  "data-analysis": [{ version: "1.0.0", released: "2026-11-28", note: NOTE, skillKeys: ["data.sql-analytics", "data.statistics", "data.visualisation", "data.experiment-analysis"], fingerprint: "f86c98ab" }],
  "design-critique": [{ version: "1.0.0", released: "2026-11-28", note: NOTE, skillKeys: ["design.design-systems", "design.accessibility", "design.typography", "design.color"], fingerprint: "28a4f1a7" }],
  "product-discovery": [{ version: "1.0.0", released: "2026-11-28", note: NOTE, skillKeys: ["product.discovery", "product.user-stories", "product.competitive-analysis", "product.metrics"], fingerprint: "4a1e908b" }],
  "support-excellence": [{ version: "1.0.0", released: "2026-11-28", note: NOTE, skillKeys: ["support.triage", "support.troubleshooting", "support.tone", "support.escalation", "support.root-cause"], fingerprint: "aa600fca" }],
  "sales-closer": [{ version: "1.0.0", released: "2026-11-28", note: NOTE, skillKeys: ["sales.discovery-calls", "sales.objection-handling", "sales.proposals", "sales.negotiation"], fingerprint: "7b9fc987" }],
  "hiring": [{ version: "1.0.0", released: "2026-11-28", note: NOTE, skillKeys: ["people.sourcing", "people.interviewing", "people.onboarding-hr", "people.performance"], fingerprint: "67c01f3d" }],
  "ops-reliability": [{ version: "1.0.0", released: "2026-11-28", note: NOTE, skillKeys: ["operations.incident-response", "operations.process-mapping", "operations.automation", "operations.project-mgmt"], fingerprint: "e02aa53c" }],
  "finance-close": [{ version: "1.0.0", released: "2026-11-28", note: NOTE, skillKeys: ["finance.modeling", "finance.budgeting", "finance.variance", "finance.reporting"], fingerprint: "effd6cba" }],
  "legal-review": [{ version: "1.0.0", released: "2026-11-28", note: NOTE, skillKeys: ["legal.contract-review", "legal.redlining", "legal.risk", "legal.compliance"], fingerprint: "ab1141b4" }],
  "teaching": [{ version: "1.0.0", released: "2026-11-28", note: NOTE, skillKeys: ["education.curriculum", "education.lesson-planning", "education.assessment", "education.tutoring"], fingerprint: "5ead9835" }],
  "care-support": [{ version: "1.0.0", released: "2026-11-28", note: NOTE, skillKeys: ["health.intake", "health.triage-support", "health.patient-education", "health.safety"], fingerprint: "3ebdbcc2" }],
  "growth-marketing": [{ version: "1.0.0", released: "2026-11-28", note: NOTE, skillKeys: ["marketing.seo", "marketing.content-strategy", "marketing.copywriting", "marketing.analytics"], fingerprint: "ed745f10" }],
};
