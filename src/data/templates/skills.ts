/**
 * ============================================================================
 *  Skill registry — the vocabulary every template is assembled from.
 * ============================================================================
 *
 *  Templates reference skills by their short id inside their own category
 *  (`'react'` in engineering, `'seo'` in marketing). This file owns the
 *  canonical name + description for each, so 500 templates stay consistent
 *  and a skill is described exactly once.
 *
 *  Adding a skill: add a row to the matching category below. Adding a
 *  template that uses an unknown id throws at module load — deliberately,
 *  so a typo never ships as a silently empty skill list.
 */

import type { CatalogSkill, TemplateCategory } from '../../types';

type Row = [id: string, name: string, description: string];

const define = (category: TemplateCategory, rows: Row[]): CatalogSkill[] =>
  rows.map(([id, name, description]) => ({ id, name, description, category }));

const BY_CATEGORY: Record<TemplateCategory, CatalogSkill[]> = {
  engineering: define('engineering', [
    ['ts', 'TypeScript', 'Reads and writes strict TypeScript, including generics, narrowing and module boundaries.'],
    ['react', 'React', 'Builds composable components with correct hook dependencies and explicit loading/empty/error states.'],
    ['css', 'CSS & layout', 'Handles layout with flexbox and grid, tokenised spacing, and responsive breakpoints.'],
    ['node', 'Node.js services', 'Writes small HTTP services, middleware chains and graceful shutdown handling.'],
    ['python', 'Python', 'Writes typed, tested Python with clear module seams and no hidden global state.'],
    ['go', 'Go', 'Idiomatic Go: explicit errors, context propagation, and goroutines with bounded lifetimes.'],
    ['rust', 'Rust', 'Ownership-aware Rust, preferring clear lifetimes over clones.'],
    ['sql', 'SQL', 'Writes readable queries and understands indexes, joins and query plans.'],
    ['api-design', 'API design', 'Shapes request/response contracts, versioning and error envelopes that stay stable.'],
    ['testing', 'Testing', 'Writes tests that fail for the right reason, at the cheapest layer that can catch the bug.'],
    ['refactoring', 'Refactoring', 'Splits seams and shrinks diffs without changing observable behaviour.'],
    ['code-review', 'Code review', 'Reviews for correctness, naming and blast radius — and says which comments block.'],
    ['perf', 'Performance', 'Profiles before optimising, then measures the delta in numbers.'],
    ['security', 'App security', 'Threat-models input, auth and secrets handling; flags injection and privilege paths.'],
    ['docker', 'Containers', 'Writes reproducible Dockerfiles and keeps images small and cache-friendly.'],
    ['k8s', 'Kubernetes', 'Reasons about probes, resources, rollout strategy and failure domains.'],
    ['ci-cd', 'CI/CD', 'Builds pipelines that fail fast, cache well and never leak credentials into logs.'],
    ['observability', 'Observability', 'Adds structured logs, metrics and traces that answer a specific operational question.'],
  ]),

  design: define('design', [
    ['figma', 'Figma', 'Works in components, variants and auto-layout instead of ad-hoc frames.'],
    ['design-systems', 'Design systems', 'Extends an existing token and component system rather than inventing a parallel one.'],
    ['typography', 'Typography', 'Pairs type, sets a scale, and fixes measure and line-height before colour.'],
    ['color', 'Colour & contrast', 'Builds accessible palettes and checks contrast against real surface colours.'],
    ['ux-research', 'UX research', 'Plans interviews and usability tests that answer a decision, not a curiosity.'],
    ['prototyping', 'Prototyping', 'Prototypes the smallest artefact that can be put in front of a user.'],
    ['accessibility', 'Accessibility', 'Covers focus order, labels, reduced motion and keyboard-only paths.'],
    ['motion', 'Motion', 'Uses motion for state change, with durations short enough to feel immediate.'],
    ['iconography', 'Iconography', 'Keeps an icon set optically consistent at the sizes it ships at.'],
    ['responsive', 'Responsive layout', 'Designs the narrow case first and names what collapses at each breakpoint.'],
  ]),

  product: define('product', [
    ['roadmapping', 'Roadmapping', 'Sequences work by risk and learning value, not by who shouted loudest.'],
    ['user-stories', 'User stories', 'Writes stories with testable acceptance criteria and an explicit non-goal.'],
    ['prioritisation', 'Prioritisation', 'Applies a stated scoring rule and shows the trade-off it forces.'],
    ['discovery', 'Discovery', 'Separates the problem being solved from the feature being requested.'],
    ['metrics', 'Product metrics', 'Defines one primary metric, its guardrails, and how it could be gamed.'],
    ['experiments', 'Experimentation', 'Sizes the effect an experiment must detect before it is worth running.'],
    ['competitive-analysis', 'Competitive analysis', 'Compares on the axis users switch on, not on feature checklists.'],
    ['spec-writing', 'Spec writing', 'Writes specs short enough to be read, with the open questions still visible.'],
  ]),

  data: define('data', [
    ['sql-analytics', 'Analytical SQL', 'Writes window-function SQL and is explicit about grain and fan-out.'],
    ['dbt', 'dbt modelling', 'Builds staged, tested models with documented joins and freshness expectations.'],
    ['pandas', 'Pandas', 'Reshapes data with vectorised operations and checks dtype assumptions first.'],
    ['visualisation', 'Data visualisation', 'Picks the chart the question needs and labels axes so it reads without a caption.'],
    ['statistics', 'Statistics', 'Chooses tests from the data shape, reports effect sizes and uncertainty.'],
    ['etl', 'ETL/ELT', 'Designs idempotent pipelines that can be re-run without duplicating rows.'],
    ['warehouse', 'Warehouse modelling', 'Separates raw, staging and mart layers with clear ownership.'],
    ['experiment-analysis', 'Experiment analysis', 'Checks assignment balance, power and multiple comparisons before calling a winner.'],
    ['ml-basics', 'Applied ML', 'Starts from a baseline and refuses to add complexity without a measured gain.'],
  ]),

  research: define('research', [
    ['literature-search', 'Literature search', 'Builds a search strategy and records what was excluded, not just what was found.'],
    ['source-evaluation', 'Source evaluation', 'Weighs primary over secondary sources and states the confidence level.'],
    ['synthesis', 'Synthesis', 'Collapses many sources into claims, with the disagreement left visible.'],
    ['citation', 'Citation', 'Cites to the specific page or dataset, never to "a study".'],
    ['interviews', 'Research interviews', 'Asks about past behaviour instead of hypothetical future intent.'],
    ['survey-design', 'Survey design', 'Writes neutral, single-barrelled questions and pilots before fielding.'],
    ['competitive-intel', 'Competitive intelligence', 'Tracks competitor changes from public signals and timestamps each finding.'],
    ['fact-checking', 'Fact-checking', 'Traces a claim to its origin and flags where a summary drifted from the source.'],
  ]),

  marketing: define('marketing', [
    ['seo', 'SEO', 'Maps intent to pages, fixes structure before copy, and avoids keyword stuffing.'],
    ['content-strategy', 'Content strategy', 'Plans a content set that answers a journey rather than a keyword list.'],
    ['copywriting', 'Copywriting', 'Leads with the concrete benefit and cuts every hedge word.'],
    ['email', 'Email marketing', 'Writes subject lines that survive a crowded inbox and one clear CTA.'],
    ['social', 'Social media', 'Adapts one idea per platform instead of cross-posting the same text.'],
    ['paid-ads', 'Paid acquisition', 'Structures campaigns around one testable variable at a time.'],
    ['brand', 'Brand voice', 'Keeps a consistent register across surfaces and names what the brand will not say.'],
    ['analytics', 'Marketing analytics', 'Attributes conversions honestly and separates correlation from incrementality.'],
  ]),

  sales: define('sales', [
    ['prospecting', 'Prospecting', 'Qualifies against a written ideal-customer profile before reaching out.'],
    ['discovery-calls', 'Discovery calls', 'Runs a call that ends with a next step agreed by both sides.'],
    ['objection-handling', 'Objection handling', 'Treats an objection as missing information and answers it without pressure.'],
    ['proposals', 'Proposals', 'Writes proposals where scope, price and exclusions are unambiguous.'],
    ['crm-hygiene', 'CRM hygiene', 'Keeps stages and next-action dates accurate enough to forecast from.'],
    ['forecasting', 'Forecasting', 'Separates committed, best-case and pipeline with stated assumptions.'],
    ['negotiation', 'Negotiation', 'Trades on value and terms rather than discounting price by reflex.'],
    ['onboarding-sales', 'Customer onboarding', 'Hands off with context so the customer never repeats themselves.'],
  ]),

  support: define('support', [
    ['triage', 'Ticket triage', 'Classifies by impact and urgency, and routes before replying.'],
    ['troubleshooting', 'Troubleshooting', 'Asks for the one datum that splits the hypothesis space, not a screenshot dump.'],
    ['tone', 'Support tone', 'Stays plain and accountable, and never blames the user or the tool.'],
    ['escalation', 'Escalation', 'Escalates with reproduction steps and a clear ask, not a forwarded thread.'],
    ['help-docs', 'Help documentation', 'Writes steps a first-time user can follow without prior context.'],
    ['macros', 'Response macros', 'Keeps canned replies specific enough to feel written for one person.'],
    ['sla', 'SLA management', 'Tracks first-response and resolution clocks and flags the ones about to breach.'],
    ['root-cause', 'Root-cause analysis', 'Separates the trigger from the underlying condition before proposing a fix.'],
  ]),

  finance: define('finance', [
    ['modeling', 'Financial modelling', 'Builds models where every assumption is a labelled input, never a hard-coded cell.'],
    ['budgeting', 'Budgeting', 'Builds a budget from drivers and shows what happens when they move.'],
    ['forecasting', 'Forecasting', 'Present three scenarios with the assumption that separates them.'],
    ['variance', 'Variance analysis', 'Explains the gap by driver, and distinguishes timing from permanent delta.'],
    ['unit-economics', 'Unit economics', 'Computes contribution margin per unit and states which costs are excluded.'],
    ['valuation', 'Valuation', 'Shows the comparable set and the sensitivity around the chosen multiple.'],
    ['ap-ar', 'AP/AR operations', 'Keeps cash timing visible and flags anything aging past terms.'],
    ['reporting', 'Financial reporting', 'Produces statements that tie out, with the reconciliation shown.'],
  ]),

  legal: define('legal', [
    ['contract-review', 'Contract review', 'Summarises obligations, term and termination before line-level comments.'],
    ['redlining', 'Redlining', 'Proposes minimal alternative language with the risk explained.'],
    ['privacy', 'Privacy', 'Maps data flows to a lawful basis and flags anything retained without one.'],
    ['ip', 'IP & licensing', 'Checks licence compatibility and ownership before reuse.'],
    ['compliance', 'Compliance', 'Turns an obligation into an owner, a control and a review cadence.'],
    ['terms', 'Terms & policies', 'Writes terms a normal user could read, without hiding the material limits.'],
    ['risk', 'Risk assessment', 'Rates likelihood against impact and names the mitigation and residual risk.'],
    ['policy', 'Policy drafting', 'Writes policy with an explicit scope and a named exception path.'],
  ]),

  people: define('people', [
    ['sourcing', 'Sourcing', 'Writes outreach that names the specific work, not the company perks.'],
    ['interviewing', 'Interviewing', 'Asks questions with a scoring rubric agreed before the call.'],
    ['onboarding-hr', 'Onboarding', 'Sequences the first two weeks so a new hire can ship something small.'],
    ['performance', 'Performance management', 'Gives feedback tied to observed behaviour and a specific next action.'],
    ['compensation', 'Compensation', 'Benchmarks against a stated market and explains the band.'],
    ['hr-policy', 'HR policy', 'Writes policy that is consistent across regions and actually enforceable.'],
    ['engagement', 'Engagement', 'Reads survey results by team and separates signal from sample noise.'],
    ['org-design', 'Org design', 'Designs reporting lines around decisions, not around people.'],
  ]),

  operations: define('operations', [
    ['process-mapping', 'Process mapping', 'Draws the current state honestly, including the workarounds.'],
    ['vendor-management', 'Vendor management', 'Reviews vendors on reliability and exit cost, not only price.'],
    ['logistics', 'Logistics', 'Plans capacity against demand variability, not the average.'],
    ['inventory', 'Inventory', 'Sets reorder points from lead time and demand spread.'],
    ['project-mgmt', 'Project management', 'Keeps dependencies and the critical path explicit and current.'],
    ['incident-response', 'Incident response', 'Runs the response, keeps a timeline, and writes the blameless follow-up.'],
    ['automation', 'Workflow automation', 'Automates the stable, high-frequency step and leaves the judgement call manual.'],
    ['okrs', 'OKRs', 'Writes key results as measurable outcomes rather than activity lists.'],
  ]),

  education: define('education', [
    ['curriculum', 'Curriculum design', 'Sequences outcomes so each unit depends on the last one.'],
    ['lesson-planning', 'Lesson planning', 'Plans around one learning objective and its misconception.'],
    ['assessment', 'Assessment', 'Writes items that test understanding, not recall of phrasing.'],
    ['scaffolding', 'Scaffolding', 'Adds support that is withdrawn as competence grows.'],
    ['feedback', 'Feedback', 'Gives feedback on the work against the goal, with one next step.'],
    ['learning-accessibility', 'Learning accessibility', 'Provides multiple representations and removes time pressure where it adds nothing.'],
    ['tutoring', 'Tutoring', 'Diagnoses the gap before explaining, and checks understanding after.'],
    ['learning-science', 'Learning science', 'Applies retrieval practice and spacing instead of re-reading.'],
  ]),

  health: define('health', [
    ['intake', 'Intake', 'Collects a structured history and flags anything needing escalation.'],
    ['triage-support', 'Triage support', 'Routes by red-flag symptoms and declines to guess at a diagnosis.'],
    ['patient-education', 'Patient education', 'Explains in plain language and checks understanding back.'],
    ['care-coordination', 'Care coordination', 'Keeps handovers and follow-ups from falling between providers.'],
    ['clinical-documentation', 'Clinical documentation', 'Documents facts, timestamps and decisions without editorialising.'],
    ['safety', 'Safety boundaries', 'Recognises when to stop advising and route to a clinician.'],
    ['wellness-coaching', 'Wellness coaching', 'Sets habits small enough to survive a bad week.'],
    ['health-compliance', 'Health compliance', 'Handles sensitive data under the minimum-necessary principle.'],
  ]),

  creative: define('creative', [
    ['storytelling', 'Storytelling', 'Builds tension from a want and an obstacle, not from adjectives.'],
    ['editing', 'Editing', 'Cuts filler, prefers concrete verbs, and keeps one idea per paragraph.'],
    ['worldbuilding', 'Worldbuilding', 'Keeps internal rules consistent and states them before bending them.'],
    ['scripting', 'Scripting', 'Writes scenes that carry information through action and subtext.'],
    ['poetry', 'Poetry', 'Works in image and rhythm, and removes any line that only explains.'],
    ['naming', 'Naming', 'Generates names that are short, sayable, and clear of collisions.'],
    ['art-direction', 'Art direction', 'Sets one visual reference and enforces it across the set.'],
    ['audio', 'Audio production', 'Mixes for speech intelligibility first and music second.'],
    ['game-design', 'Game design', 'Tunes a core loop and its feedback before adding content.'],
    ['comedy', 'Comedy writing', 'Writes the setup plainly and puts the turn last.'],
  ]),
};

/** Flattened registry keyed `category.id`, built once at module load. */
export const SKILLS: Record<string, CatalogSkill> = Object.entries(BY_CATEGORY).reduce(
  (acc, [category, skills]) => {
    for (const skill of skills) {
      acc[`${category}.${skill.id}`] = skill;
    }
    return acc;
  },
  {} as Record<string, CatalogSkill>,
);

/**
 * Look up a skill by short id within a category.
 * Throws on a typo so a broken reference fails loudly at module load.
 */
export function getSkill(category: TemplateCategory, id: string): CatalogSkill {
  const skill = SKILLS[`${category}.${id}`];
  if (!skill) {
    const known = BY_CATEGORY[category].map((s) => s.id).join(', ');
    throw new Error(`Unknown skill "${id}" in category "${category}". Known: ${known}`);
  }
  return skill;
}

/** Every skill in one category — used by the picker's skill filter later on. */
export function getSkillsForCategory(category: TemplateCategory): CatalogSkill[] {
  return BY_CATEGORY[category];
}
