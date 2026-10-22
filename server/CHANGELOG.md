# Changelog

## [0.20.4](https://github.com/MartinM10/Myrmo/compare/server-v0.20.3...server-v0.20.4) (2026-10-22)


### Documentation

* Claude Desktop needs an Extension for a colony behind SSH, not mcpServers ([#226](https://github.com/MartinM10/Myrmo/issues/226)) ([455f62b](https://github.com/MartinM10/Myrmo/commit/455f62b601480bc71034ba77d7c9ef5d80e2a113))

## [0.20.3](https://github.com/MartinM10/Myrmo/compare/server-v0.20.2...server-v0.20.3) (2026-10-21)


### Bug fixes

* **panel:** the invitations carry the colony's address, not the one the operator has open ([#222](https://github.com/MartinM10/Myrmo/issues/222)) ([9ce9abc](https://github.com/MartinM10/Myrmo/commit/9ce9abc292cc167dd1ce6c8d19ab85f8ff1af457))

## [0.20.2](https://github.com/MartinM10/Myrmo/compare/server-v0.20.1...server-v0.20.2) (2026-10-19)


### Bug fixes

* a deploy that does not fill the disk, pinned MCP versions in the docs, and validate says what publishing would refuse ([#214](https://github.com/MartinM10/Myrmo/issues/214)) ([2b59384](https://github.com/MartinM10/Myrmo/commit/2b593841dd0fecafb5c831a8b7e5dbb2fe276ac5))

## [0.20.1](https://github.com/MartinM10/Myrmo/compare/server-v0.20.0...server-v0.20.1) (2026-10-16)


### Bug fixes

* harden the deploy path, release jobs, CI pins, images and self-hosting scripts ([#201](https://github.com/MartinM10/Myrmo/issues/201)) ([5c7026b](https://github.com/MartinM10/Myrmo/commit/5c7026bb7e79cd9cd02a8885905afc9e0b16891f))
* **redact:** credentials with no name in front, and five more token formats ([#195](https://github.com/MartinM10/Myrmo/issues/195)) ([16ddcac](https://github.com/MartinM10/Myrmo/commit/16ddcacca706a3fc223f573e9eeeff02c28d891b))
* **server:** close ways to inflate trails or flood a colony from many addresses ([#197](https://github.com/MartinM10/Myrmo/issues/197)) ([6ef60e2](https://github.com/MartinM10/Myrmo/commit/6ef60e29a2f88cd625201baa26451d886e295c96))
* **server:** commands in prose, error type envelope, credential throttle, private-colony browser and proxy defaults ([#202](https://github.com/MartinM10/Myrmo/issues/202)) ([ab219e2](https://github.com/MartinM10/Myrmo/commit/ab219e2eebc0b7cfa16e1dc5d781e975ffb9d2fb))

## [0.20.0](https://github.com/MartinM10/Myrmo/compare/server-v0.19.0...server-v0.20.0) (2026-10-16)


### Features

* backups readable by their owner only, and a panel that says when the last one was ([#186](https://github.com/MartinM10/Myrmo/issues/186)) ([d3f21a9](https://github.com/MartinM10/Myrmo/commit/d3f21a91bd49af377212cb40a98b62b552d19347))
* knowledge that lasts, corrections by the author, and a person's "still valid" ([#185](https://github.com/MartinM10/Myrmo/issues/185)) ([6a0570b](https://github.com/MartinM10/Myrmo/commit/6a0570b9b2fccf1780ea54eaacb2ecc936e62848))
* what agents learn following a trail reaches the next ones, and a fix can succeed a trail ([#181](https://github.com/MartinM10/Myrmo/issues/181)) ([6fc3ff7](https://github.com/MartinM10/Myrmo/commit/6fc3ff762236693b726b9770df0523f87a18028d))


### Bug fixes

* a pilot summary that only claims what it measured, and an accurate comparison page ([#183](https://github.com/MartinM10/Myrmo/issues/183)) ([978314d](https://github.com/MartinM10/Myrmo/commit/978314dfba749fcb694d5bee3452477d0c9e1570))
* **redact:** a shell variable followed by a colon is not a password ([#187](https://github.com/MartinM10/Myrmo/issues/187)) ([ebfaa3c](https://github.com/MartinM10/Myrmo/commit/ebfaa3cdaec33c6933430b1672a9ddfdf0b38905))

## [0.19.0](https://github.com/MartinM10/Myrmo/compare/server-v0.18.0...server-v0.19.0) (2026-10-15)


### Features

* **b2b:** batch API keys, hold-out ROI telemetry and sybil hardening for pilots ([51dcdc8](https://github.com/MartinM10/Myrmo/commit/51dcdc8bd9452f35abd46354e88234aae4e64efc))


### Bug fixes

* **ci:** rustfmt, clippy dead code, gitleaks allowlist and sync llms.txt ([18c5492](https://github.com/MartinM10/Myrmo/commit/18c5492cb099d8841603affba3255942241cc06c))

## [0.18.0](https://github.com/MartinM10/Myrmo/compare/server-v0.17.0...server-v0.18.0) (2026-10-15)


### Features

* **admin:** fill list prices for more Claude and Gemini models ([e5e3fd8](https://github.com/MartinM10/Myrmo/commit/e5e3fd8756486c23f8dfe2c4faf188128ee368a8))

## [0.17.0](https://github.com/MartinM10/Myrmo/compare/server-v0.16.0...server-v0.17.0) (2026-10-14)


### Features

* **server:** measured value, a randomised hold-out, team-level activity by default, erasure ([5b38024](https://github.com/MartinM10/Myrmo/commit/5b380249fbdc5d581d7b4e907bdd388f5e1de45e))


### Bug fixes

* **server:** harden the rules and the new endpoints against a capable attacker ([b4946b8](https://github.com/MartinM10/Myrmo/commit/b4946b806cb5c79aeea09d29b9b0c20380d8c42f))

## [0.16.0](https://github.com/MartinM10/Myrmo/compare/server-v0.15.0...server-v0.16.0) (2026-10-14)


### Features

* **admin:** overhaul admin panel UX/UI and interactive knowledge map ([9efbf25](https://github.com/MartinM10/Myrmo/commit/9efbf25855df319e3fcf682dcb4ed5702d24027c))

## [0.15.0](https://github.com/MartinM10/Myrmo/compare/server-v0.14.0...server-v0.15.0) (2026-10-13)


### Features

* **server:** say which client versions were released with the colony, and who runs which ([c8c8826](https://github.com/MartinM10/Myrmo/commit/c8c8826301c3d994fe37eacdda2a30cba00716c1))

## [0.14.0](https://github.com/MartinM10/Myrmo/compare/server-v0.13.0...server-v0.14.0) (2026-10-13)


### Features

* **server:** a knowledge map in the admin panel ([47a20f6](https://github.com/MartinM10/Myrmo/commit/47a20f6f0b3d8d16130e887ba54c31a4cfaddd9e))
* **server:** a Knowledge tab in the admin panel ([2bcbdaa](https://github.com/MartinM10/Myrmo/commit/2bcbdaaecc59c98ed0c8bf816c91e2493899017d))
* **server:** admin panel v2: the colony, trails with authors, activity, alerts ([1f1aede](https://github.com/MartinM10/Myrmo/commit/1f1aede11dda93564e1b92834cfbc40218e84a41))
* **server:** organisation mode and a task index for private colonies ([2483c73](https://github.com/MartinM10/Myrmo/commit/2483c734c8f7313d1232e9c73be59abc23da0bf3))
* **server:** the admin panel shows the colony like its public page: trails with their author, activity per day and per person, alerts ([a7e5c2e](https://github.com/MartinM10/Myrmo/commit/a7e5c2e5e7962fb67df76617101f9fd7fd631cad))


### Bug fixes

* **server:** panel copy button on plain HTTP ([9aae967](https://github.com/MartinM10/Myrmo/commit/9aae9670a3f8bad7218b8d89cba13f087c46b4c5))
* **server:** the panel's copy button works on a plain HTTP page ([f3cc344](https://github.com/MartinM10/Myrmo/commit/f3cc344dd15830ed3b420c2194351c00cbfa3d8d))

## [0.13.0](https://github.com/MartinM10/Myrmo/compare/server-v0.12.0...server-v0.13.0) (2026-10-13)


### Features

* say which colony every answer is about, and smaller private-colony fixes ([614e8c4](https://github.com/MartinM10/Myrmo/commit/614e8c4babb924754a03ee968c3906ef5a90b779))
* **server:** a refused network is told which address the colony sees, and the refusal is logged ([7b49d34](https://github.com/MartinM10/Myrmo/commit/7b49d34cd12548fb570c3e47546db95a771d61d4))

## [0.12.0](https://github.com/MartinM10/Myrmo/compare/server-v0.11.0...server-v0.12.0) (2026-10-13)


### Features

* private colony network filter, invitations and doctor ([d474cdc](https://github.com/MartinM10/Myrmo/commit/d474cdcefb511456e6179198765de635e229b7d1))
* **server:** admin panel for the operator ([a532866](https://github.com/MartinM10/Myrmo/commit/a532866cc90daca33b2255eed4804a132a07c8e9))
* **server:** an admin panel for the operator, at /admin ([c399a51](https://github.com/MartinM10/Myrmo/commit/c399a517084664756507dc22df207853d32766ab))
* **server:** MYRMO_ALLOWED_NETWORKS, only the listed networks may connect ([1639b1e](https://github.com/MartinM10/Myrmo/commit/1639b1eefb666626a8a1dd0846ffc18b43892baf))

## [0.11.0](https://github.com/MartinM10/Myrmo/compare/server-v0.10.0...server-v0.11.0) (2026-10-13)


### Features

* count rejected trails by reason, and tell a publisher what to fix ([29da03d](https://github.com/MartinM10/Myrmo/commit/29da03d8a40684da0e96f10baa2a4362f018d905))
* **server:** a rejected trail says what to fix: the parts the model flagged, and a hint ([dde0123](https://github.com/MartinM10/Myrmo/commit/dde01232686e1c6306578e6f7a99772702d8fef4))
* **server:** count rejected and refused trails by reason, without any text ([3aabe1c](https://github.com/MartinM10/Myrmo/commit/3aabe1cc0a51c9c17905b692782e79fa4644faa8))

## [0.10.0](https://github.com/MartinM10/Myrmo/compare/server-v0.9.0...server-v0.10.0) (2026-10-12)


### Features

* a team's private colony on one machine, in one command ([7972969](https://github.com/MartinM10/Myrmo/commit/7972969a051fc5aaf82a889eca4a9eafab4429ce))
* a team's private colony on one machine, in one command ([8e42bd3](https://github.com/MartinM10/Myrmo/commit/8e42bd3c65b037b5ac5903a8bf64d058d6df0c8c))

## [0.9.0](https://github.com/MartinM10/Myrmo/compare/server-v0.8.0...server-v0.9.0) (2026-10-11)


### Features

* private colony onboarding in one command, and a team report ([2790341](https://github.com/MartinM10/Myrmo/commit/27903419807052fb5397c7849462f22a559e1416))
* **server:** team-report, what each person of a private colony does with it ([d4a13a7](https://github.com/MartinM10/Myrmo/commit/d4a13a7828313422b08555109e26840d22d35d40))

## [0.8.0](https://github.com/MartinM10/Myrmo/compare/server-v0.7.3...server-v0.8.0) (2026-10-11)


### Features

* access keys for private colonies, and hooks that look errors up and ask to share ([5a6ab17](https://github.com/MartinM10/Myrmo/commit/5a6ab175267179ba694596a059d1535cdaceba4f))
* **server:** access keys for a private colony ([06e2b36](https://github.com/MartinM10/Myrmo/commit/06e2b3641f5db7aeab71adb7aad02bba7b854c8d))


### Bug fixes

* a private colony's answers are never cacheable, and the hooks never look up the public colony ([add4dd7](https://github.com/MartinM10/Myrmo/commit/add4dd7fbe171e9c33b71135035456dfc7435462))
* **server:** with access keys, everything counted per address is counted per person ([9a7f4d9](https://github.com/MartinM10/Myrmo/commit/9a7f4d943bb888897361feedb7a00483c78af9f8))

## [0.7.3](https://github.com/MartinM10/Myrmo/compare/server-v0.7.2...server-v0.7.3) (2026-10-10)


### Bug fixes

* **server:** believe X-Forwarded-For only from trusted proxies, and keep checks out of public stats ([b817463](https://github.com/MartinM10/Myrmo/commit/b8174631dcd6677811b4548d422a22a37de4ea0c))
* **server:** believe X-Forwarded-For only from trusted proxies, and keep checks out of public stats ([9322fbd](https://github.com/MartinM10/Myrmo/commit/9322fbd2556a27eb4eb30e2da075d15d3ca5aea5))

## [0.7.2](https://github.com/MartinM10/Myrmo/compare/server-v0.7.1...server-v0.7.2) (2026-10-09)


### Bug fixes

* a hit about another module, image or repository is not an answer ([0400c81](https://github.com/MartinM10/Myrmo/commit/0400c81a77713d27a0ab0da7a3fefc0707f7f4c6))
* **server:** a hit about another module, image or repository is not an answer ([ed51450](https://github.com/MartinM10/Myrmo/commit/ed514500fa2377ec535d10ce12384e7d409af583))

## [0.7.1](https://github.com/MartinM10/Myrmo/compare/server-v0.7.0...server-v0.7.1) (2026-10-09)


### Bug fixes

* **server:** a fingerprint key keeps at most 64 trails ([c962d1a](https://github.com/MartinM10/Myrmo/commit/c962d1a03cd5947b6a00467e1617721c15c3f8cb))
* **server:** a fingerprint key keeps at most 64 trails ([36a9419](https://github.com/MartinM10/Myrmo/commit/36a9419f7c05baa0ee71010da12abe81cf3c79fa))
* **tests:** live check accepts the terms and names its User-Agent ([0585a4d](https://github.com/MartinM10/Myrmo/commit/0585a4d8a90e16b9c1510d66b38249fb9d30bf20))
* **tests:** live check accepts the terms when it approves a draft and names its User-Agent ([19eccad](https://github.com/MartinM10/Myrmo/commit/19eccad6ea8453233b5a3ff505ac70449a68302b))
* **tests:** live check expects that the publisher's own address cannot confirm its trail ([1ade18f](https://github.com/MartinM10/Myrmo/commit/1ade18f7d2d675ff99decf239f24dec59207ad29))

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
