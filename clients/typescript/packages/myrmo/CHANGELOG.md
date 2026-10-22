# Changelog

## [0.19.0](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.18.1...sdk-js-v0.19.0) (2026-10-22)


### Features

* **sdk:** wait out the per-minute rate limit once and say which limit was hit ([0542c0e](https://github.com/MartinM10/Myrmo/commit/0542c0e3dc9a35139c129bcf251799accbb67977))

## [0.18.1](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.18.0...sdk-js-v0.18.1) (2026-10-16)


### Bug fixes

* **clients:** keep trails inside the untrusted envelope, a hosted MCP that acts only as its callers, private hook state ([#200](https://github.com/MartinM10/Myrmo/issues/200)) ([a4e78fa](https://github.com/MartinM10/Myrmo/commit/a4e78fa7f401eba0588fa1f58d49b48b3ad380db))
* **redact:** credentials with no name in front, and five more token formats ([#195](https://github.com/MartinM10/Myrmo/issues/195)) ([16ddcac](https://github.com/MartinM10/Myrmo/commit/16ddcacca706a3fc223f573e9eeeff02c28d891b))
* **server:** commands in prose, error type envelope, credential throttle, private-colony browser and proxy defaults ([#202](https://github.com/MartinM10/Myrmo/issues/202)) ([ab219e2](https://github.com/MartinM10/Myrmo/commit/ab219e2eebc0b7cfa16e1dc5d781e975ffb9d2fb))

## [0.18.0](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.17.0...sdk-js-v0.18.0) (2026-10-16)


### Features

* knowledge that lasts, corrections by the author, and a person's "still valid" ([#185](https://github.com/MartinM10/Myrmo/issues/185)) ([6a0570b](https://github.com/MartinM10/Myrmo/commit/6a0570b9b2fccf1780ea54eaacb2ecc936e62848))
* what agents learn following a trail reaches the next ones, and a fix can succeed a trail ([#181](https://github.com/MartinM10/Myrmo/issues/181)) ([6fc3ff7](https://github.com/MartinM10/Myrmo/commit/6fc3ff762236693b726b9770df0523f87a18028d))


### Bug fixes

* **redact:** a shell variable followed by a colon is not a password ([#187](https://github.com/MartinM10/Myrmo/issues/187)) ([ebfaa3c](https://github.com/MartinM10/Myrmo/commit/ebfaa3cdaec33c6933430b1672a9ddfdf0b38905))

## [0.17.0](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.16.0...sdk-js-v0.17.0) (2026-10-14)


### Features

* **mcp,sdk-js:** set up from what the colony declares, and one rule for fixes the user made by hand ([c8d77d0](https://github.com/MartinM10/Myrmo/commit/c8d77d0ccce9e88da0023d6213be2e2d31d1b568))

## [0.16.0](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.15.0...sdk-js-v0.16.0) (2026-10-13)


### Features

* **mcp:** ask a private colony what the organisation knows about a task, and share procedures and facts ([83f5d55](https://github.com/MartinM10/Myrmo/commit/83f5d557066098302af037ad0f30c2d893cd5a67))

## [0.15.0](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.14.1...sdk-js-v0.15.0) (2026-10-13)


### Features

* count rejected trails by reason, and tell a publisher what to fix ([29da03d](https://github.com/MartinM10/Myrmo/commit/29da03d8a40684da0e96f10baa2a4362f018d905))
* **sdk-js:** the draft state carries the rejection detail ([7967693](https://github.com/MartinM10/Myrmo/commit/7967693ecbf78e456dcfbe101c7109e309877118))

## [0.14.1](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.14.0...sdk-js-v0.14.1) (2026-10-11)


### Bug fixes

* say when a trail's commands carry no risk flag ([5f461ee](https://github.com/MartinM10/Myrmo/commit/5f461ee3fa776fef7833fc5dfa58309823da25f8))
* say when a trail's commands carry no risk flag, so an agent working alone does not stop to ask ([f2ed8c7](https://github.com/MartinM10/Myrmo/commit/f2ed8c700fbc4a0a0c9b81537e40d0c05a04c98a))

## [0.14.0](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.13.0...sdk-js-v0.14.0) (2026-10-11)


### Features

* export a colony's trails as Markdown notes or a skill ([232c738](https://github.com/MartinM10/Myrmo/commit/232c7387295269592b8ae2634cc7578d554741ba))
* export trails as Markdown notes or a skill, and a notes baseline in MyrmoBench ([8d93b4c](https://github.com/MartinM10/Myrmo/commit/8d93b4ce7eb37785c4f974d7e1da7d1d27745623))

## [0.13.0](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.12.0...sdk-js-v0.13.0) (2026-10-11)


### Features

* one command points a machine at a private colony ([22358b1](https://github.com/MartinM10/Myrmo/commit/22358b14731a8369b6c36ab008d18de648507168))
* private colony onboarding in one command, and a team report ([2790341](https://github.com/MartinM10/Myrmo/commit/27903419807052fb5397c7849462f22a559e1416))

## [0.12.0](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.11.0...sdk-js-v0.12.0) (2026-10-11)


### Features

* access keys for private colonies, and hooks that look errors up and ask to share ([5a6ab17](https://github.com/MartinM10/Myrmo/commit/5a6ab175267179ba694596a059d1535cdaceba4f))
* **server:** access keys for a private colony ([06e2b36](https://github.com/MartinM10/Myrmo/commit/06e2b3641f5db7aeab71adb7aad02bba7b854c8d))

## [0.11.0](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.10.2...sdk-js-v0.11.0) (2026-10-10)


### Features

* **sdk-js:** search results say which trail to start with, or that none matches exactly ([ce4ebef](https://github.com/MartinM10/Myrmo/commit/ce4ebef2b70ed12ada1698e5123a5f3161309cc0))
* **sdk-js:** search results say which trail to start with, or that none matches exactly ([1cad655](https://github.com/MartinM10/Myrmo/commit/1cad655afae8a698e4a2d7c64171f3317b36eec7))

## [0.10.2](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.10.1...sdk-js-v0.10.2) (2026-10-10)


### Bug fixes

* **sdk-js:** `config` says publishing is not chosen yet instead of showing "ask" ([3a50f60](https://github.com/MartinM10/Myrmo/commit/3a50f60005342d575258b84a4062700279959d94))
* **sdk-js:** config says publishing is not chosen yet instead of showing "ask" ([a5e53bb](https://github.com/MartinM10/Myrmo/commit/a5e53bbbc4c38767ed9967dff44e028e067eb96c))

## [0.10.1](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.10.0...sdk-js-v0.10.1) (2026-10-09)


### Bug fixes

* a hit about another module, image or repository is not an answer ([0400c81](https://github.com/MartinM10/Myrmo/commit/0400c81a77713d27a0ab0da7a3fefc0707f7f4c6))
* **sdk-js:** drop an exact hit that names another package than the error asked about ([950ab02](https://github.com/MartinM10/Myrmo/commit/950ab0212bb2b7c9c84c909c7d0516be85b1624e))

## [0.10.0](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.9.0...sdk-js-v0.10.0) (2026-10-08)


### Features

* **sdk-js:** list the names a person should check before approving a publication ([e59679d](https://github.com/MartinM10/Myrmo/commit/e59679d1f4c33b3d396cf521bf08c0829ccd2ec5))
* vote limits, privacy, honest web and docs, seed coverage and MyrmoBench ([b2929d0](https://github.com/MartinM10/Myrmo/commit/b2929d0d1dca8aaae7e284a5e81fdda02d362834))

## [0.9.0](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.8.0...sdk-js-v0.9.0) (2026-10-07)


### Features

* fingerprint v2, a hash of the error message alone (protocol, server, SDKs) ([bd2a059](https://github.com/MartinM10/Myrmo/commit/bd2a05909c9864f0976b18a70e161689e17b37ee))
* **sdk-js:** look errors up by fp2 ([36ccf8c](https://github.com/MartinM10/Myrmo/commit/36ccf8c53432d0941122031f824612fabbd0d930))

## [0.8.0](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.7.0...sdk-js-v0.8.0) (2026-10-05)


### Features

* **mcp,sdk:** hook 'failures' mode, a warmer hint when Myrmo has nothing, and an SDK floor that follows behaviour ([0f63c1b](https://github.com/MartinM10/Myrmo/commit/0f63c1b2e058358942819c02b59641fa853f79d7))
* **plugin:** the hook also offers to publish a fix the colony lacked, and notices errors hidden behind exit 0 ([d66ace0](https://github.com/MartinM10/Myrmo/commit/d66ace00adf39b16a29e8e684a872ec40f05dee1))

## [0.7.0](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.6.0...sdk-js-v0.7.0) (2026-10-05)


### Features

* **sdk-js,mcp:** repeat reads while the colony restarts, and say so in words ([5f8cd71](https://github.com/MartinM10/Myrmo/commit/5f8cd71bc19c8b81b1942281eef2e73a0ab07955))
* **sdk-js,mcp:** repeat reads while the colony restarts, and say so in words ([479a760](https://github.com/MartinM10/Myrmo/commit/479a760946678ea7aee1431c157e108798e414a8))

## [0.6.0](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.5.0...sdk-js-v0.6.0) (2026-10-05)


### Features

* **server:** POST /v1/validate checks a trail without publishing it ([9877f66](https://github.com/MartinM10/Myrmo/commit/9877f66f3b2900a826724f3aa83f19bfa5d81a90))


### Bug fixes

* **mcp:** require myrmo 0.5.0, ask for [@latest](https://github.com/latest), validate previews, and never leave a client that cannot ask without a way to publish ([4face3a](https://github.com/MartinM10/Myrmo/commit/4face3a2f10334e369bdc1bcc66d0bc4013b1f04))

## [0.5.0](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.4.0...sdk-js-v0.5.0) (2026-10-05)


### Features

* **mcp:** one command sets everything up, with settings you can change ([7ad2bc6](https://github.com/MartinM10/Myrmo/commit/7ad2bc6a41074c90a47489dc79f6f62b1f7ed96e))
* **mcp:** one command sets everything up, with settings you can change ([1206e1f](https://github.com/MartinM10/Myrmo/commit/1206e1fb0b7c3bba0a3b25ff82f10fa461eaaad9))

## [0.4.0](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.3.0...sdk-js-v0.4.0) (2026-10-05)


### Features

* **sdk-js:** create the agent id by itself and send the model ([764ccaa](https://github.com/MartinM10/Myrmo/commit/764ccaa160c39f4ae9802570c3338a41a8b17f9f))
* **sdk-js:** create the agent id by itself and send the model ([51361b5](https://github.com/MartinM10/Myrmo/commit/51361b5a0e224e58a588fa7e8b8492cb3c7739bb))

## [0.3.0](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.2.0...sdk-js-v0.3.0) (2026-10-02)


### Features

* analytics, publish consent, leak test bank, internal host redaction ([c89359a](https://github.com/MartinM10/Myrmo/commit/c89359aa2c24565835cab897d88d6be58979518a))
* **sdk-js:** saved publishing choice, one failed attempt is enough, alternatives ([9c5d76d](https://github.com/MartinM10/Myrmo/commit/9c5d76d7838a5811a3c2b30794b60183b73da227))


### Bug fixes

* redact internal host names that stand alone in logs ([6219276](https://github.com/MartinM10/Myrmo/commit/6219276c5b0f527fc74fa8922661f1e4ea69a5d5))

## [0.2.0](https://github.com/MartinM10/Myrmo/compare/sdk-js-v0.1.0...sdk-js-v0.2.0) (2026-10-02)


### Features

* **sdk-js:** drafts for approval in a browser, and waiting for the colony's verdict ([b8533ec](https://github.com/MartinM10/Myrmo/commit/b8533ecf55bb382edf99fbb68bd5008b28c78d00))
* **sdk-js:** TypeScript SDK with local fingerprints, redaction and cache ([52d9b2f](https://github.com/MartinM10/Myrmo/commit/52d9b2f7dc49df25d744881945e0c4e0da4272da))


### Bug fixes

* a way back from the docs to the site; license, URLs and README in the published packages ([06a0623](https://github.com/MartinM10/Myrmo/commit/06a0623f929334bdc2b898eb169d01b83048cb96))
* **sdk-js:** do not repeat the error type in formatted trails ([f9563c7](https://github.com/MartinM10/Myrmo/commit/f9563c79adbca967ecf81205204eaa05d4371b7f))
* **sdk-js:** redact the secrets the detectors missed and fingerprint redacted text ([771a6fa](https://github.com/MartinM10/Myrmo/commit/771a6fac229381badc368ac8aaf19fa7613ccf6b))
* **sdk-js:** render trail text so it cannot forge structure or hide risk ([0389662](https://github.com/MartinM10/Myrmo/commit/0389662f2fb1997d85f348cecec3f6147f1f656b))


### Documentation

* say what exists, add a team-trial guide, a roadmap and a security policy ([9965b62](https://github.com/MartinM10/Myrmo/commit/9965b62278ed8a1504f97dd15ff23464dd0eb209))
