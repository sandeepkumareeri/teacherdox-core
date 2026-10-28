# Contributing

Thank you for helping. TeacherDox Core is small on purpose: one reference implementation, a
specification and test vectors that let anyone build another one. Changes are judged by whether
they keep it correct, verifiable and easy to read.

## Before you start

- For anything larger than a fix, open an issue first and describe the change.
- Security problems: do **not** open an issue — see [`SECURITY.md`](SECURITY.md).
- Never add real educator or student data, photos, voice notes, API keys or private keys to the
  repository, including in tests, issues and pull requests. Fixtures are synthetic.

## Set up

Node.js 22 or newer. No install is needed to run the tests: there are no runtime dependencies.

```bash
git clone https://github.com/sandeepkumareeri/teacherdox-core
cd teacherdox-core
npm test                 # the whole suite (Linux, macOS, Windows)
npm install              # dev dependencies only: typescript, @types/node
npm run typecheck        # tsc --noEmit --checkJs over src/tdx
npm run coverage         # tests with a coverage table
```

CI runs the tests on Linux and Windows, the type check, coverage and CodeQL on every push and pull
request ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Rules for changes

- **Keep `src/tdx` dependency-free** and fully typed with JSDoc (the type check is strict).
- **The specification leads.** A change to what a capsule contains or how it is verified changes
  [`spec/tdx-2.0.md`](spec/tdx-2.0.md) and [`spec/schema/tdx-2.0.schema.json`](spec/schema/tdx-2.0.schema.json)
  in the same pull request, with tests. Regenerate the vectors (`node scripts/make-vectors.js`) when the
  format changes and say why in the pull request; vectors are a contract other implementations
  check themselves against.
- **Every rule has a test.** A new MUST in the spec gets a test that fails without it.
- **Signed capsules are immutable.** Corrections are new capsules (`amend`); never add a way to edit a
  signed record.
- **Verifier messages may change; failure codes may not** (spec §9). Add codes; do not rename them.
- **Both verifiers agree.** If you change verification, change `src/tdx` and the browser verifier
  (`src/verifier/webverify.js`), then `npm run build:verifier`; the tests require identical reports.
- **The engine never invents.** A field the models could not read stays empty and the record is
  held or routed to the educator. Every model call writes provenance (provider, model, time, tokens,
  cost — `null` when a price is not published, never estimated).
- **The core never depends on one vendor.** Model providers are adapters; Google is reached only
  through a function the host passes in (`fromGenerate`), never from `src/`.
- **Claims are measured.** Numbers in docs come from real runs (link the run). No user numbers,
  endorsements or partnerships.
- **Packs:** non-English locale text is marked as a draft translation until a native speaker has
  reviewed it (see [`packs/README.md`](packs/README.md)).

## Style

Plain CommonJS, no build step. Match the surrounding code: short functions, comments that say why,
names from the glossary in [`spec/00-core-architecture.md`](spec/00-core-architecture.md). Commit
messages say what changed and why in the first line.

## Licence

By contributing you agree that your contribution is licensed under the Apache License 2.0
([`LICENSE`](LICENSE)), as stated in section 5 of that licence.
