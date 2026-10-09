# Changelog

## [0.10.1](https://github.com/MartinM10/Myrmo/compare/sdk-python-v0.10.0...sdk-python-v0.10.1) (2026-10-09)


### Bug fixes

* a hit about another module, image or repository is not an answer ([0400c81](https://github.com/MartinM10/Myrmo/commit/0400c81a77713d27a0ab0da7a3fefc0707f7f4c6))
* **sdk-python:** drop an exact hit that names another package than the error asked about ([a68f844](https://github.com/MartinM10/Myrmo/commit/a68f84472c40cdab992cde547bb0403be2b0600a))

## [0.10.0](https://github.com/MartinM10/Myrmo/compare/sdk-python-v0.9.0...sdk-python-v0.10.0) (2026-10-08)


### Features

* **sdk-python:** list the names a person should check before approving a publication ([ee7c75a](https://github.com/MartinM10/Myrmo/commit/ee7c75aa4243cb6252584f5f08185451dd84c614))
* vote limits, privacy, honest web and docs, seed coverage and MyrmoBench ([b2929d0](https://github.com/MartinM10/Myrmo/commit/b2929d0d1dca8aaae7e284a5e81fdda02d362834))

## [0.9.0](https://github.com/MartinM10/Myrmo/compare/sdk-python-v0.8.0...sdk-python-v0.9.0) (2026-10-07)


### Features

* fingerprint v2, a hash of the error message alone (protocol, server, SDKs) ([bd2a059](https://github.com/MartinM10/Myrmo/commit/bd2a05909c9864f0976b18a70e161689e17b37ee))
* **sdk-python:** look errors up by fp2 ([800e9a2](https://github.com/MartinM10/Myrmo/commit/800e9a215e63bb2db0d7678b5e93bb2bba6f5b67))

## [0.8.0](https://github.com/MartinM10/Myrmo/compare/sdk-python-v0.7.0...sdk-python-v0.8.0) (2026-10-05)


### Features

* **mcp,sdk:** hook 'failures' mode, a warmer hint when Myrmo has nothing, and an SDK floor that follows behaviour ([0f63c1b](https://github.com/MartinM10/Myrmo/commit/0f63c1b2e058358942819c02b59641fa853f79d7))
* **plugin:** the hook also offers to publish a fix the colony lacked, and notices errors hidden behind exit 0 ([d66ace0](https://github.com/MartinM10/Myrmo/commit/d66ace00adf39b16a29e8e684a872ec40f05dee1))

## [0.7.0](https://github.com/MartinM10/Myrmo/compare/sdk-python-v0.6.0...sdk-python-v0.7.0) (2026-10-05)


### Features

* **sdk-js,mcp:** repeat reads while the colony restarts, and say so in words ([5f8cd71](https://github.com/MartinM10/Myrmo/commit/5f8cd71bc19c8b81b1942281eef2e73a0ab07955))
* **sdk-python:** repeat reads while the colony restarts, and say so in words ([f786966](https://github.com/MartinM10/Myrmo/commit/f786966cf5d7ce54cb7ac282c0d993d361a94cd5))

## [0.6.0](https://github.com/MartinM10/Myrmo/compare/sdk-python-v0.5.0...sdk-python-v0.6.0) (2026-10-05)


### Features

* **sdk-python:** validate() asks the colony whether it would accept a trail ([6f2cbe4](https://github.com/MartinM10/Myrmo/commit/6f2cbe4da05d1b813628469d8555f12488130774))
* **server:** POST /v1/validate checks a trail without publishing it ([9877f66](https://github.com/MartinM10/Myrmo/commit/9877f66f3b2900a826724f3aa83f19bfa5d81a90))

## [0.5.0](https://github.com/MartinM10/Myrmo/compare/sdk-python-v0.4.0...sdk-python-v0.5.0) (2026-10-05)


### Features

* **mcp:** one command sets everything up, with settings you can change ([7ad2bc6](https://github.com/MartinM10/Myrmo/commit/7ad2bc6a41074c90a47489dc79f6f62b1f7ed96e))
* **sdk-python:** the same settings as the TypeScript client ([5ddd205](https://github.com/MartinM10/Myrmo/commit/5ddd205c8a7c1c561232a1ed7e6aa2e539026fe2))

## [0.4.0](https://github.com/MartinM10/Myrmo/compare/sdk-python-v0.3.0...sdk-python-v0.4.0) (2026-10-05)


### Features

* **sdk-js:** create the agent id by itself and send the model ([764ccaa](https://github.com/MartinM10/Myrmo/commit/764ccaa160c39f4ae9802570c3338a41a8b17f9f))
* **sdk-python:** create the agent id by itself and send the model ([9baf6b3](https://github.com/MartinM10/Myrmo/commit/9baf6b3a6118123531901c094b444e9dcfff966e))

## [0.3.0](https://github.com/MartinM10/Myrmo/compare/sdk-python-v0.2.0...sdk-python-v0.3.0) (2026-10-02)


### Features

* analytics, publish consent, leak test bank, internal host redaction ([c89359a](https://github.com/MartinM10/Myrmo/commit/c89359aa2c24565835cab897d88d6be58979518a))
* **sdk-python:** saved publishing choice, one failed attempt is enough, alternatives ([e659119](https://github.com/MartinM10/Myrmo/commit/e659119388576f5e136137970d3400d5d751c0e6))


### Bug fixes

* redact internal host names that stand alone in logs ([6219276](https://github.com/MartinM10/Myrmo/commit/6219276c5b0f527fc74fa8922661f1e4ea69a5d5))

## [0.2.0](https://github.com/MartinM10/Myrmo/compare/sdk-python-v0.1.0...sdk-python-v0.2.0) (2026-10-02)


### Features

* **sdk-python:** drafts for approval in a browser, and waiting for the colony's verdict ([4c78ecd](https://github.com/MartinM10/Myrmo/commit/4c78ecd80de1d611c9788a389487238606fd33f2))
* **sdk-python:** Python SDK with sync and async clients and framework adapters ([aa5f042](https://github.com/MartinM10/Myrmo/commit/aa5f042530225e7c25c07ec43d017cc68627ba8a))


### Bug fixes

* a way back from the docs to the site; license, URLs and README in the published packages ([06a0623](https://github.com/MartinM10/Myrmo/commit/06a0623f929334bdc2b898eb169d01b83048cb96))
* **sdk-python:** do not repeat the error type in formatted trails ([b8c1ede](https://github.com/MartinM10/Myrmo/commit/b8c1ede317c7597c6c34c7487db0d7f832182ab1))
* **sdk-python:** redact the secrets the detectors missed ([8c2e939](https://github.com/MartinM10/Myrmo/commit/8c2e93951356ad3d909ddada889329cf1e5fc4e7))
* **sdk-python:** render trail text so it cannot forge structure or hide risk ([cdedd8e](https://github.com/MartinM10/Myrmo/commit/cdedd8e8613db2f8d550e2b1a7aa78900e9fef97))
* **web:** install tab that works, a Copy button that copies what to type, and a real security contact ([9097b84](https://github.com/MartinM10/Myrmo/commit/9097b841559aae53e68bde6a10c42b8047fdb6ba))


### Documentation

* say what exists, add a team-trial guide, a roadmap and a security policy ([9965b62](https://github.com/MartinM10/Myrmo/commit/9965b62278ed8a1504f97dd15ff23464dd0eb209))
