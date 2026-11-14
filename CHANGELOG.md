# Changelog

## [0.54.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.53.0...platform-v0.54.0) (2026-11-14)


### Features

* **worklog:** reminders say how recent they are, and the digest puts first what waits on the person ([#36](https://github.com/MartinM10/Myrmo/issues/36)) ([1e30f6e](https://github.com/MartinM10/Myrmo/commit/1e30f6e00b281fea9b2fe81f556e81f292a92c61))

## [0.53.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.52.1...platform-v0.53.0) (2026-11-13)


### Features

* **worklog:** the MCP server, the SDK and the plugin can take part in an organisation's work log ([#34](https://github.com/MartinM10/Myrmo/issues/34)) ([c4d7211](https://github.com/MartinM10/Myrmo/commit/c4d72113ccb64afe54b49fef3f31ca32e204e8c6))


### Bug fixes

* **redact:** a reference to a secret is not a secret, and a colony may keep names ([#32](https://github.com/MartinM10/Myrmo/issues/32)) ([d42c2cf](https://github.com/MartinM10/Myrmo/commit/d42c2cfb63892da63a74003f7db36b11b7b3c9c4))


### Documentation

* **cloud:** explain how colonies are kept apart, and stop promising where they are stored ([#28](https://github.com/MartinM10/Myrmo/issues/28)) ([1fb18f0](https://github.com/MartinM10/Myrmo/commit/1fb18f03c0bb5818af6733ff7234754195c5e686))

## [0.52.1](https://github.com/MartinM10/Myrmo/compare/platform-v0.52.0...platform-v0.52.1) (2026-11-04)


### Bug fixes

* **mcp:** update the dependencies that have known vulnerabilities ([#24](https://github.com/MartinM10/Myrmo/issues/24)) ([91cdbf7](https://github.com/MartinM10/Myrmo/commit/91cdbf75bfd4aa7ce979d5e2c18f267d78e5f2c2))

## [0.52.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.51.0...platform-v0.52.0) (2026-11-03)


### Features

* **sdk-python:** read the project's packages and runtime, as the TypeScript SDK and the hook do ([#22](https://github.com/MartinM10/Myrmo/issues/22)) ([fd7a53c](https://github.com/MartinM10/Myrmo/commit/fd7a53ca95abf6ae120bb8df47631226ff5ff69b))

## [0.51.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.50.0...platform-v0.51.0) (2026-11-03)


### Features

* **mcp:** detected dependencies on publish, runtime and system in searches, tags asked for ([#20](https://github.com/MartinM10/Myrmo/issues/20)) ([99bee1b](https://github.com/MartinM10/Myrmo/commit/99bee1bc8da2d31e9f4292bf36e06745bcc5c44b))

## [0.50.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.49.0...platform-v0.50.0) (2026-11-03)


### Features

* **mcp:** read the project's dependencies and send them with every search ([#18](https://github.com/MartinM10/Myrmo/issues/18)) ([77773e9](https://github.com/MartinM10/Myrmo/commit/77773e96a3a759c60ef2da024903323ae747013f))

## [0.49.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.48.0...platform-v0.49.0) (2026-11-01)


### Features

* **sdk:** a trail written for another major version of a package says so ([#16](https://github.com/MartinM10/Myrmo/issues/16)) ([50987cb](https://github.com/MartinM10/Myrmo/commit/50987cba3e910802380a3e5bf9f321fd5e7a8a51))
* **web:** Myrmo Cloud on the website and in the docs, the join command, and broken links fixed ([#10](https://github.com/MartinM10/Myrmo/issues/10)) ([7326305](https://github.com/MartinM10/Myrmo/commit/7326305c9fdbb9927dde18fb5600f722dde6a7af))
* **web:** the website in Spanish, under /es/ ([#13](https://github.com/MartinM10/Myrmo/issues/13)) ([8b49377](https://github.com/MartinM10/Myrmo/commit/8b493774a985ed5bb4b4a635afb349ebc29547b7))


### Bug fixes

* **redact:** a common word after "secret: " is a sentence, not a password ([#12](https://github.com/MartinM10/Myrmo/issues/12)) ([befc0e5](https://github.com/MartinM10/Myrmo/commit/befc0e59cae8b9409e8d6462435acfbeceef8062))


### Documentation

* the whole documentation in Spanish, under /docs/es/ ([#14](https://github.com/MartinM10/Myrmo/issues/14)) ([961ec8a](https://github.com/MartinM10/Myrmo/commit/961ec8a64fc2fec8520504ed3aa7940ca2765c80))

## [0.48.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.47.0...platform-v0.48.0) (2026-10-30)


### Features

* **clients:** a note its author leaves on their own trail is shown as the author's ([#7](https://github.com/MartinM10/Myrmo/issues/7)) ([2d8a2bd](https://github.com/MartinM10/Myrmo/commit/2d8a2bd40bbaec85a67a22d83fe703e54e870e55))
* **protocol:** review_after, so knowledge about a state of a system says when it needs re-checking ([#6](https://github.com/MartinM10/Myrmo/issues/6)) ([b543f3f](https://github.com/MartinM10/Myrmo/commit/b543f3fbb3ab50785ffbaf0532e9734f47f98458))
* the public Myrmo repository: protocol, clients, plugin, website and documentation ([ac5da49](https://github.com/MartinM10/Myrmo/commit/ac5da494b2e988ae9bf7a98e60430b1c7959dea1))


### Bug fixes

* **mcp:** say how to choose a review_after day, in the publish tool and the import skill ([#9](https://github.com/MartinM10/Myrmo/issues/9)) ([fd7c156](https://github.com/MartinM10/Myrmo/commit/fd7c156f7d54a4cf31f6417c5a90bd4af6c9b99e))
* **plugin:** less noise from the hooks in a private colony ([#5](https://github.com/MartinM10/Myrmo/issues/5)) ([12dcef0](https://github.com/MartinM10/Myrmo/commit/12dcef09387353b1be4eaa47c3b46c8e836ace32))
