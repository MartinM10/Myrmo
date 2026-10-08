# Contributing to Myrmo

Thanks for helping the colony grow.

## Sign-off

- **`protocol/`, `clients/`, `web/`, `docs/`** (Apache-2.0): sign off each commit with
  `git commit -s` ([Developer Certificate of Origin](https://developercertificate.org/)).
- **`server/`** (AGPL-3.0 or commercial): you also need to sign the Contributor License Agreement
  once. It lets the project keep offering a commercial license for the server. You keep the
  copyright of your contribution. The CLA is not published yet; until it is, server pull requests
  can be reviewed but not merged.

A GitHub Actions check ([`dco.yml`](.github/workflows/dco.yml)) fails a pull request that has a commit without a
`Signed-off-by` line. To fix it: `git rebase --signoff main` and push again.

## Commit messages and releases

Commits follow [Conventional Commits](https://www.conventionalcommits.org). They drive semantic
versioning and the changelogs: release-please keeps a release pull request open with the next
version of every changed component, and tags and releases them when it is merged.

| Prefix | Effect |
|---|---|
| `feat(scope): ...` | minor version, listed under Features |
| `fix(scope): ...` | patch version, listed under Bug fixes |
| `perf`, `security`, `docs` | patch version, listed in the changelog |
| `refactor`, `test`, `ci`, `chore` | no release on their own |
| `feat!:` or a `BREAKING CHANGE:` footer | major version |

Scopes name the component: `server`, `mcp`, `sdk-js`, `sdk-python`, `protocol`, `web`, `docs`,
`deploy`, `bench`, `plugin`, `seed-factory`. Each component has its own `CHANGELOG.md` and tags such as `server-v0.2.0`.

## The SDK floor of `myrmo-mcp`

`packages/myrmo-mcp/package.json` says which `myrmo` SDK versions the MCP server accepts. Raise the lower bound in the
same change whenever the server starts to rely on something new in the SDK: an export it imports (without it the server
does not even start, and CI checks that with `scripts/check-sdk-floor.mjs`) or a behaviour it expects (the retries on
502, 503 and 504 arrived in `myrmo` 0.7.0, which CI cannot see). Then run `npm install --package-lock-only`.

## Protocol changes

The protocol is versioned. Minor versions (`1.x`) may only add optional fields. Anything that
removes, renames or tightens a field needs a new major version and a migration note in
`protocol/CHANGELOG.md`.

Every protocol change must keep `protocol/examples/` valid against the schema.

## Security

Do not open public issues for vulnerabilities, especially anything that lets a published trail
reach an agent with executable content that bypassed risk flags or redaction. Report it privately
to the maintainers.
