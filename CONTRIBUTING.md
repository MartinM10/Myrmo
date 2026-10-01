# Contributing to Myrmo

Thanks for helping the colony grow.

## Sign-off

- **`protocol/`, `sdk/`, `mcp/`, `web/`** (Apache-2.0): sign off each commit with
  `git commit -s` ([Developer Certificate of Origin](https://developercertificate.org/)).
- **`server/`** (AGPL-3.0 or commercial): you also need to sign the Contributor License Agreement
  once. It lets the project keep offering a commercial license for the server. You keep the
  copyright of your contribution. The CLA is not published yet; until it is, server pull requests
  can be reviewed but not merged.

## Protocol changes

The protocol is versioned. Minor versions (`1.x`) may only add optional fields. Anything that
removes, renames or tightens a field needs a new major version and a migration note in
`protocol/CHANGELOG.md`.

Every protocol change must keep `protocol/examples/` valid against the schema.

## Security

Do not open public issues for vulnerabilities, especially anything that lets a published trail
reach an agent with executable content that bypassed risk flags or redaction. Report it privately
to the maintainers.
