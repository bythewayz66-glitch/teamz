# Templates and the Team Library (Phase 3)

Stacked on Phase 2 (#8) and Phase 1 (#7). Standalone Teamz: no backend, nothing written to the runner, nothing deployed.

## What is in the library

| Kind | Source | Review state on arrival |
|---|---|---|
| **Teamz fleet** (8 templates) | Generated from the fleet's own files by `scripts/build-library-seeds.mjs` into `src/data/library/seeds.generated.ts`. Prompts and first jobs are copied verbatim; `--check` (and a test) fails if the file drifts from the sources. | `builtin`: shipped through a reviewed PR |
| **Published here** | Any agent in the browser workspace, published from the library panel. Each publish is a new semver version with a required note. | `unreviewed` every time, including after a previously approved version |
| **Gamut import** | A `.agent` file, parsed in the browser. | `unreviewed` |

The eight fleet templates: Orchestrator, Reviewer, Website Currency Agent, Drift Monitor, Backend Architect, Code Reviewer, QA Tester, Bug Analysis Agent. The roadmap names the first four. The other four are a judgement, picked because they carry the longest recorded work chain in `future-work-104.json` (the #456–#458 fix, review and test chain, and the Backend Architect findings the Bug Analysis Agent triages). Swap them freely: it is one list in the generator.

Each template states what it does (the prompt's own opening sentences, never rewritten), what it needs (runner tools the prompt names, model and provider), what is inside (prompt size, model, budget, skills, first job), a version, and its source file.

## The Reviewer gate

An unreviewed or rejected template cannot become an agent: `agentInputFromTemplate` throws, the Create button is disabled with the reason, and `createAgentFromLibrary` in the store calls the same function, so there is no second path. Recording a decision needs a name and a reason. Teamz cannot authenticate who types, so the panel says so: it records the Reviewer's decision and does not make one. Anything an agent made here lives in the browser workspace; it is not a runner fleet agent.

## One-click creation and the first session

"Create agent" makes the agent and a session named `First job — <title>`. The session holds no invented messages. It shows a card with the job the template was actually proven on, its source file and, for a recurring job, its schedule. Nothing is sent until the user presses "Run this job" (one request to the agent), or types something else. A template with no first job says so.

Most fleet first jobs are the point-in-time jobs the agents were given (for example issues #456–#458); they are shown as they were, not generalised.

## Versions and "what changed"

Every template keeps all its versions. The diff covers summary, prompt (line diff), model, provider, iteration budget, avatar, needs, runner tools, skills and first job. Fleet templates have one version (1.0.0): the fleet has no earlier recorded form, and none was made up. A second version appears when a published template is published again; the comparison is demonstrated in the browser check and in tests.

Skill bundles (15, covering 60 of the registry's 135 skills) have a release table in `src/data/library/bundleReleases.ts`: version, date, note, members and a fingerprint. `skillLibrary.test.ts` fails if a bundle or one of its skills changes without a new release, so the library cannot drift silently. Each bundle has one release (1.0.0) today.

## Gamut import

Built to what the Gamut importer is documented to accept (`gamut-reference/README.md`): a ZIP with `CLAUDE.md` or `AGENTS.md` at the root (a single wrapper directory is tolerated, `__MACOSX/` ignored), YAML frontmatter with `name`, `description`, `createdAt`, then Markdown instructions. Path traversal, encrypted entries, ZIP64, unknown compression, an unreadable or nested frontmatter, a missing name, description or body, and a real `.env` are all refused with a reason. The instructions are kept exactly as exported (`rawInstructions`), the body becomes the system prompt on instantiation, and `.env.example` is read for variable names only: no value is stored. Limits: 10,000 files like Gamut, 50 MB total (Gamut allows 2 GB; this is held in browser memory).

**Unverified.** No genuine Gamut export exists (see the README): the gamut-clone on jnet1 has no export feature. The only archive is `company-brain.agent`, a real Gamut template packaged in the verified container shape. The importer parses it and the tests pin its contents, but the gate ("a Gamut export imports verbatim and its agent runs a first session") needs a file from Gamut's own Export button. The importer also assumes frontmatter is flat `key: value`; a real export with nested frontmatter would be refused, not guessed at. A Full export (with keys) is refused if it carries a `.env`; the Full layout itself is not known.

## Wizard

Step 2 is now "Name & look": name first, then eight avatar shapes, 24 colours and 48 faces, with a live preview. The shape is stored on the agent (`avatarShape`) and drawn everywhere avatars appear. The existing four-step flow, composed prompt, skills picker and budgets are unchanged.

## Not done

- Gate checks that need live use: a template-made agent finishing its first real job without prompt repair, and a real Gamut export.
- The fleet prompts carry mem20 context, including the 527-tool / 135-domain surface figures as they were written. A template is a faithful copy, so those figures are as stale as the prompts; the Reviewer may want them refreshed at the source.
- The wizard does not yet offer library templates as a starting point (the library creates directly).
- Library and published/imported templates live in this browser's localStorage (`teamz:library:v1`), not on the server.
- The 473-template catalogue already in the repo is untouched.
