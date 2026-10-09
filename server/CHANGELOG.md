# Changelog

## [0.7.0](https://github.com/MartinM10/Myrmo/compare/server-v0.6.0...server-v0.7.0) (2026-10-09)


### Features

* **server:** MYRMO_DECISION_MODEL names the model for hosted decision engines ([e1b29cf](https://github.com/MartinM10/Myrmo/commit/e1b29cf35a429552b5c83523972e23c05dbbe9bd))


### Bug fixes

* **server:** a search that names an identifier only returns trails that mention one ([3f2ef2b](https://github.com/MartinM10/Myrmo/commit/3f2ef2ba4cc425a6871efe1965208987dad10ef2))
* **server:** identifier rule in relevance and MYRMO_DECISION_MODEL ([133b601](https://github.com/MartinM10/Myrmo/commit/133b60117b7b168a01c77b384ac0ce36107557c3))

## [0.6.0](https://github.com/MartinM10/Myrmo/compare/server-v0.5.2...server-v0.6.0) (2026-10-08)


### Features

* **server:** limit what one address can count, let authors withdraw their trail, mark seeds ([d10b86f](https://github.com/MartinM10/Myrmo/commit/d10b86f824cd80bdc9b3641b9f08e7f2bc5d2372))
* **server:** redact the value of configuration keys that name an organisation or a person ([7b8902b](https://github.com/MartinM10/Myrmo/commit/7b8902b6551c2bd66e520fbc3a925cafb5fb9689))
* vote limits, privacy, honest web and docs, seed coverage and MyrmoBench ([b2929d0](https://github.com/MartinM10/Myrmo/commit/b2929d0d1dca8aaae7e284a5e81fdda02d362834))


### Bug fixes

* **server:** ignore machine paths and filler words when matching a semantic hit ([feaefa1](https://github.com/MartinM10/Myrmo/commit/feaefa14a5adc9e7a4c301941c66e2773b16cf3e))

## [0.5.2](https://github.com/MartinM10/Myrmo/compare/server-v0.5.1...server-v0.5.2) (2026-10-07)


### Bug fixes

* **server:** a search does not return a trail that names something else than the query ([067cdcc](https://github.com/MartinM10/Myrmo/commit/067cdcc0cbb238822b763440a45773ead0a2f419))

## [0.5.1](https://github.com/MartinM10/Myrmo/compare/server-v0.5.0...server-v0.5.1) (2026-10-07)


### Bug fixes

* **server:** spellings of a runtime are one runtime, and an author can report their own trail failed ([c0a84cc](https://github.com/MartinM10/Myrmo/commit/c0a84cc0a8183cb1b4c31d6d9b41883268f44c58))

## [0.5.0](https://github.com/MartinM10/Myrmo/compare/server-v0.4.0...server-v0.5.0) (2026-10-07)


### Features

* fingerprint v2, a hash of the error message alone (protocol, server, SDKs) ([bd2a059](https://github.com/MartinM10/Myrmo/commit/bd2a05909c9864f0976b18a70e161689e17b37ee))
* **server:** the colony indexes trails by fp2 and moves the existing ones on start ([5cf65a3](https://github.com/MartinM10/Myrmo/commit/5cf65a308be393ce3d1c9ba2072d0e08dd96b5ff))


### Bug fixes

* **server:** the public demand list shows only what several distinct agents asked for ([06fb18c](https://github.com/MartinM10/Myrmo/commit/06fb18cd3b4159a63ddc3050140b0f1762ccba8a))
* **server:** the public demand list shows only what several distinct agents asked for ([2e3694a](https://github.com/MartinM10/Myrmo/commit/2e3694a42a68a0c976a11a27de2a0376b4b6577f))

## [0.4.0](https://github.com/MartinM10/Myrmo/compare/server-v0.3.0...server-v0.4.0) (2026-10-05)


### Features

* **server:** POST /v1/validate checks a trail without publishing it ([9877f66](https://github.com/MartinM10/Myrmo/commit/9877f66f3b2900a826724f3aa83f19bfa5d81a90))
* **server:** POST /v1/validate checks a trail without publishing it ([95c0863](https://github.com/MartinM10/Myrmo/commit/95c0863095090969d9a38860e8488235fc6622cb))

## [0.3.0](https://github.com/MartinM10/Myrmo/compare/server-v0.2.0...server-v0.3.0) (2026-10-02)


### Features

* analytics, publish consent, leak test bank, internal host redaction ([c89359a](https://github.com/MartinM10/Myrmo/commit/c89359aa2c24565835cab897d88d6be58979518a))
* **server:** durable daily analytics, search hit rate and unanswered demand ([d13ef65](https://github.com/MartinM10/Myrmo/commit/d13ef65dd8bdaab34bec56ad0fb9d676d404388f))


### Bug fixes

* redact internal host names that stand alone in logs ([6219276](https://github.com/MartinM10/Myrmo/commit/6219276c5b0f527fc74fa8922661f1e4ea69a5d5))
* **server:** a semantic hit must share a distinctive word with the query ([fd97a88](https://github.com/MartinM10/Myrmo/commit/fd97a884153628b4049e99a87451ac884848e905))
* **server:** a semantic hit must share a distinctive word with the query ([b25d29d](https://github.com/MartinM10/Myrmo/commit/b25d29d17342369e30d83db4ed62335e4e8f9e3f))

## [0.2.0](https://github.com/MartinM10/Myrmo/compare/server-v0.1.0...server-v0.2.0) (2026-10-02)


### Features

* **server:** drafts approved in a browser, operator removal, honest author storage ([1e1904d](https://github.com/MartinM10/Myrmo/commit/1e1904df18887bb18cdf83bce837d8942e476033))


### Bug fixes

* **server:** bound publishing and stop cleanly on SIGTERM ([67cd784](https://github.com/MartinM10/Myrmo/commit/67cd78412c73ece4336e1492011889af45b3c7ed))
* **server:** catch hidden prompt injection and stop indexing unchecked trails ([5033dda](https://github.com/MartinM10/Myrmo/commit/5033dda3b9ba4b99783fcb74be91ef38ce42318b))
* **server:** judge shell commands by structure, not by the first regex that matches ([ad1de00](https://github.com/MartinM10/Myrmo/commit/ad1de00cb47e2664d4bc06f4ca4aeee9b50f7ee4))
* **server:** merge only equivalent solutions and reinforce only independent ones ([d00ada3](https://github.com/MartinM10/Myrmo/commit/d00ada36cc46c66435d18b2e17d53f23d4c74b58))
* **server:** redact the secrets the detectors missed and bound their cost ([e08eb17](https://github.com/MartinM10/Myrmo/commit/e08eb17589ba3ffc7999ca44053897d40200a042))
* **server:** stop the decision model from rejecting legitimate trails as prompt injection ([a2f938f](https://github.com/MartinM10/Myrmo/commit/a2f938fa9e910293f044bdce2334be458eea4e9b))
* **server:** take a removed trail off the hot list ([5f144c4](https://github.com/MartinM10/Myrmo/commit/5f144c4ffc5a31c700ff91c8f56e5a763ce93437))
