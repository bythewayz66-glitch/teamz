# Gamut import — reference material

How the Teamz verbatim Gamut import is verified. Read this before building the importer.

## What happened (Nov 25, 2026)

Jesse said the gamut-clone on jnet1 could produce a Gamut export. It cannot:

- `/root/gamut-clone` on jnet1 is Jesse's own **cleanroom re-implementation** of
  gamut.so (marketing site + agent app backed by mem20agentz + Electron shell),
  **not** a clone of the Gamut.so repo (SkillfulAgents/Gamut). No `.git`, no
  Gamut.so code.
- It has **no agent export feature anywhere**: the string "export" appears in
  no `.ts`/`.tsx`/`.py` under `app/src`, `backend`, `services`, `site/src`
  (only `export default` in the two `vite.config.ts` files); the running
  backend's OpenAPI (port 48099) lists no export route; the app UI has no
  export/download/share control. Agents exist in it (e.g. GithubSpecialist),
  but they are mem20agentz profiles, not Gamut workspaces — there is nothing
  to export in Gamut's format.
- No real Gamut instance exists on jnet1 (no binary, no Docker images, no
  Gamut server process), and no `.agent` file exists anywhere on the box.

## What this directory holds instead

- **`company-brain.agent`** — a test fixture, NOT an export produced by
  Gamut's Export button. It is a real Gamut agent template directory
  (`company-brain`, from the public repo **SkillfulAgents/gamut-templates**,
  commit `7fe1a70` "Sync Gamut agent templates"), packaged as a ZIP with the
  entries at the root — the container shape Gamut's own import code accepts
  (verified against `src/shared/lib/services/agent-template-service.ts` in
  SkillfulAgents/Gamut: `.agent` = ZIP; instructions entry `CLAUDE.md` (legacy)
  or `AGENTS.md` at the template root; YAML frontmatter `name`, `description`,
  `createdAt` + Markdown instructions body; wrapper-dir prefix tolerated;
  `__MACOSX/` ignored; path traversal rejected; max 10,000 files / 2 GB).
  Contents: `CLAUDE.md` (8,589 bytes, frontmatter name "Company Brain",
  createdAt 2026-06-04), `README.md`, `knowledge-store.json`,
  `.env.example`, `.claude/skills/agent-onboarding/SKILL.md`.
- **`templates_catalog.json`** — the 131-template catalog extracted from the
  same public repo by the gamut-clone's own
  `services/api/scripts/extract_templates.py` (copied from jnet1). Derived
  reference data, not an export.

## What still needs a genuine export

A `.agent` file produced by Gamut's own **Export Agent / Export Full Agent**
button (template mode = no secrets/sessions; full mode = entire workspace
including keys) remains the gold-standard verification. If Jesse ever exports
one from a real Gamut instance, verify the importer against it before calling
the import done. Until then, the fixture above is the honest verification
basis: real Gamut content, in the verified container shape.
