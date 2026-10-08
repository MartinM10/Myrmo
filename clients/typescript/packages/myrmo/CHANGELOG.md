# Changelog

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
