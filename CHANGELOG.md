# Changelog

## [0.17.1](https://github.com/MartinM10/Myrmo/compare/platform-v0.17.0...platform-v0.17.1) (2026-10-09)


### Documentation

* **bench:** compare decision engines, and what a fourth batch does to coverage ([065db5c](https://github.com/MartinM10/Myrmo/commit/065db5ceb3dfb6566ede824b913cb0b7884d4330))
* **bench:** fingerprint limit at 5,600 per key; LAYA_REPLICAS ([0688b5e](https://github.com/MartinM10/Myrmo/commit/0688b5ed475ca211d50114c5ed8c0c3b54fb99c6))
* **bench:** the fingerprint limit at 5,600 trails per key; LAYA_REPLICAS keeps Laya stopped ([ae7512c](https://github.com/MartinM10/Myrmo/commit/ae7512cc9fdaf93fcf2441a906a4f520c47384db))

## [0.17.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.16.0...platform-v0.17.0) (2026-10-09)


### Features

* **bench:** MyrmoBench can run OpenCode agents ([5d065f4](https://github.com/MartinM10/Myrmo/commit/5d065f4b83346e7ce169d1ac2fb34b0b1263c1f0))
* **bench:** MyrmoBench can run OpenCode agents, to measure cheaper follower models ([63c3080](https://github.com/MartinM10/Myrmo/commit/63c308018a6133a1d306df3d3718b18f237e3b12))


### Bug fixes

* **server:** a fingerprint key keeps at most 64 trails ([c962d1a](https://github.com/MartinM10/Myrmo/commit/c962d1a03cd5947b6a00467e1617721c15c3f8cb))
* **server:** a fingerprint key keeps at most 64 trails ([36a9419](https://github.com/MartinM10/Myrmo/commit/36a9419f7c05baa0ee71010da12abe81cf3c79fa))

## [0.16.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.15.0...platform-v0.16.0) (2026-10-09)


### Features

* **server:** MYRMO_DECISION_MODEL names the model for hosted decision engines ([e1b29cf](https://github.com/MartinM10/Myrmo/commit/e1b29cf35a429552b5c83523972e23c05dbbe9bd))


### Bug fixes

* **deploy:** let the origin lock accept the machine itself and private networks ([d060020](https://github.com/MartinM10/Myrmo/commit/d060020fdf165dacbf02f4aa74c35b0561d2624e))
* **deploy:** let the origin lock accept the machine itself and private networks ([1d87bf0](https://github.com/MartinM10/Myrmo/commit/1d87bf06cbc30999dab0e762e56012497e7ccbaa))
* **server:** a search that names an identifier only returns trails that mention one ([3f2ef2b](https://github.com/MartinM10/Myrmo/commit/3f2ef2ba4cc425a6871efe1965208987dad10ef2))
* **server:** identifier rule in relevance and MYRMO_DECISION_MODEL ([133b601](https://github.com/MartinM10/Myrmo/commit/133b60117b7b168a01c77b384ac0ce36107557c3))


### Documentation

* name the hosted decision engine among the recipients of redacted trail text ([2cdb6fa](https://github.com/MartinM10/Myrmo/commit/2cdb6fa14a21ebec0277e2db44e2c60736046d39))

## [0.15.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.14.0...platform-v0.15.0) (2026-10-08)


### Features

* **bench:** a coverage set measured on errors no trail was made from ([a00ee7f](https://github.com/MartinM10/Myrmo/commit/a00ee7f2f2101c5df4db1b2c5dba47e134d3c781))
* **bench:** coverage runs before and after the first 45 trails ([5294afb](https://github.com/MartinM10/Myrmo/commit/5294afb5fb1f9bccf5a183aae1965d05bc86567f))
* **bench:** MyrmoBench runner and four tasks ([d4c659a](https://github.com/MartinM10/Myrmo/commit/d4c659a049104ecb380a4db03c24517f591117a0))
* **deploy:** off-site backups, a script to close the origin to Cloudflare only, uptime and DCO checks ([cba6af0](https://github.com/MartinM10/Myrmo/commit/cba6af098197c2d1196c6a3e0b61abee9d1edd2e))
* **seed-factory:** a catalog by ecosystem, replay, candidates and demand tools ([9feeaef](https://github.com/MartinM10/Myrmo/commit/9feeaeffec8cca49861b2c9b629974077a85ab20))
* **server:** limit what one address can count, let authors withdraw their trail, mark seeds ([d10b86f](https://github.com/MartinM10/Myrmo/commit/d10b86f824cd80bdc9b3641b9f08e7f2bc5d2372))
* vote limits, privacy, honest web and docs, seed coverage and MyrmoBench ([b2929d0](https://github.com/MartinM10/Myrmo/commit/b2929d0d1dca8aaae7e284a5e81fdda02d362834))


### Bug fixes

* **plugin:** start one exact version of myrmo-mcp ([f22ffc5](https://github.com/MartinM10/Myrmo/commit/f22ffc510889086c5bcd51696ed5d39be0966abc))
* **web:** say what the code does ([36e9398](https://github.com/MartinM10/Myrmo/commit/36e9398f01f4c4b77196bfa5781ace2fcc24de0c))


### Documentation

* privacy policy, terms of service and the rest of the documentation ([0ec8d5b](https://github.com/MartinM10/Myrmo/commit/0ec8d5bed16f1a34ea6575d352d86d7e793faac2))

## [0.14.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.13.0...platform-v0.14.0) (2026-10-08)


### Features

* **mcp:** tell agents to search also when something misbehaves without an error message ([1d4f9d2](https://github.com/MartinM10/Myrmo/commit/1d4f9d219c7803c9d50896d287fb268ddd7a8c4c))


### Documentation

* how to install the plugin per user, per project or only for you ([2b4703a](https://github.com/MartinM10/Myrmo/commit/2b4703a1a998275367644af6605c62fb72e0bb57))
* **plugin:** the skill also covers misbehaviour without an error message ([1a75e67](https://github.com/MartinM10/Myrmo/commit/1a75e671810e187148ce8d2580ccde67e7568845))

## [0.13.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.12.0...platform-v0.13.0) (2026-10-08)


### Features

* **docs:** follow the system theme and share the choice with the website; add motion ([1ce7513](https://github.com/MartinM10/Myrmo/commit/1ce75133a6c210b413c71a84457bd20b51dbe231))
* **web:** light/dark switch, one GitHub icon, and motion across web and docs ([1d127a2](https://github.com/MartinM10/Myrmo/commit/1d127a27f043942fa204003b0a82a8842c356cea))
* **web:** light/dark switch, one GitHub icon, and scroll and entrance animations ([876a9d0](https://github.com/MartinM10/Myrmo/commit/876a9d011c26f518114d25ede309533fb962d9ed))


### Bug fixes

* **web:** the hero simulation no longer speeds up the longer the page stays open ([1e0ca07](https://github.com/MartinM10/Myrmo/commit/1e0ca0706d512c1da962b7e6358b144b91a9b701))


### Documentation

* list every page in the docs index, and how to work on the website ([720fbc7](https://github.com/MartinM10/Myrmo/commit/720fbc7b47e02f2129486628673169b44a394d1f))

## [0.12.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.11.1...platform-v0.12.0) (2026-10-07)


### Features

* **web:** every docs page is also served as markdown, with one file for all of them ([355a345](https://github.com/MartinM10/Myrmo/commit/355a345b556465560c78be1fcb34f1c3819159aa))


### Documentation

* architecture, components, development, and using Myrmo next to other sources ([4982b85](https://github.com/MartinM10/Myrmo/commit/4982b85123d34b29bb0dc6a11bfe71533e3f4528))
* the clients that init sets up, and the shape each one uses ([03fddf3](https://github.com/MartinM10/Myrmo/commit/03fddf34f5a1ba2c9f781ec6feb629793bbc11d2))
* the name check, with the scale figures before and after ([22caf7c](https://github.com/MartinM10/Myrmo/commit/22caf7cadd9f1767235d6428a97083aa6a531cd2))

## [0.11.1](https://github.com/MartinM10/Myrmo/compare/platform-v0.11.0...platform-v0.11.1) (2026-10-07)


### Documentation

* the runtime spellings and what an author can report ([30e1457](https://github.com/MartinM10/Myrmo/commit/30e145739e11507e2f8bda431212b59b3fd4e6ff))

## [0.11.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.10.1...platform-v0.11.0) (2026-10-07)


### Features

* fingerprint v2, a hash of the error message alone (protocol, server, SDKs) ([bd2a059](https://github.com/MartinM10/Myrmo/commit/bd2a05909c9864f0976b18a70e161689e17b37ee))
* **protocol:** fingerprint v2, a hash of the error message alone ([821b338](https://github.com/MartinM10/Myrmo/commit/821b338320ddf9ff67bc4e4d3eab7cdab8c54837))
* **seed-factory:** every seeded trail records where it comes from, and nothing is published without it ([31d880b](https://github.com/MartinM10/Myrmo/commit/31d880b76b6573bb98009bbff59cfd8477b370a8))
* **seed-factory:** every seeded trail records where it comes from, and nothing is published without it ([a941414](https://github.com/MartinM10/Myrmo/commit/a941414544a528f5867d4341a30cc2292860665d))


### Bug fixes

* **seed-factory:** files and finds trails by fp2, and the retrieval benchmark measures it ([8803f5d](https://github.com/MartinM10/Myrmo/commit/8803f5d62be58a313e6246a71b540f7c5db74cc2))
* **server:** the public demand list shows only what several distinct agents asked for ([06fb18c](https://github.com/MartinM10/Myrmo/commit/06fb18cd3b4159a63ddc3050140b0f1762ccba8a))
* **server:** the public demand list shows only what several distinct agents asked for ([2e3694a](https://github.com/MartinM10/Myrmo/commit/2e3694a42a68a0c976a11a27de2a0376b4b6577f))
* **web:** redirect docs paths requested without the /docs/ prefix ([18e4439](https://github.com/MartinM10/Myrmo/commit/18e44397aba5854e58adc7959ed4382ddaa637b7))
* **web:** redirect docs paths requested without the /docs/ prefix ([d6e745d](https://github.com/MartinM10/Myrmo/commit/d6e745de182cbf4b426944d18f58fe9fb52deb79))


### Documentation

* bring the pages up to date with fp2, the hook, the MCP instructions and the benchmarks ([71c269e](https://github.com/MartinM10/Myrmo/commit/71c269e5e6f43b2fcc54ad95db3efd220f8ddea3))
* bring the pages up to date with fp2, the hook, the MCP instructions and the benchmarks ([3de45b7](https://github.com/MartinM10/Myrmo/commit/3de45b7116efe179323bbda9e24a6f04e777c03e))
* fingerprints are fp2, with the measurements behind the change ([e3f069e](https://github.com/MartinM10/Myrmo/commit/e3f069ed6c897f7a07d132c87dbe3d456e3f371a))

## [0.10.1](https://github.com/MartinM10/Myrmo/compare/platform-v0.10.0...platform-v0.10.1) (2026-10-06)


### Bug fixes

* **plugin:** the hook reads compound commands and stops quoting lines that are not errors ([fe34e16](https://github.com/MartinM10/Myrmo/commit/fe34e16bf3eb20c944ed2946467d2993ae74811b))
* **plugin:** the hook reads compound commands and stops quoting lines that are not errors ([060e05e](https://github.com/MartinM10/Myrmo/commit/060e05e8f81ba3fa43c53060791b6f9c035fe859))

## [0.10.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.9.0...platform-v0.10.0) (2026-10-05)


### Features

* **plugin:** the hook also offers to publish a fix the colony lacked, and notices errors hidden behind exit 0 ([d66ace0](https://github.com/MartinM10/Myrmo/commit/d66ace00adf39b16a29e8e684a872ec40f05dee1))
* **plugin:** the hook also offers to publish a fix the colony lacked, and notices errors hidden behind exit 0 ([f15a50f](https://github.com/MartinM10/Myrmo/commit/f15a50fb9659cc4f708631b36094ebc573948b21))


### Documentation

* the hook's three moments, the hook modes and the SDK floor rule ([b2b22b3](https://github.com/MartinM10/Myrmo/commit/b2b22b37e6a470255066a735ac8633af993958bc))

## [0.9.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.8.0...platform-v0.9.0) (2026-10-05)


### Features

* **sdk-js,mcp:** repeat reads while the colony restarts, and say so in words ([5f8cd71](https://github.com/MartinM10/Myrmo/commit/5f8cd71bc19c8b81b1942281eef2e73a0ab07955))

## [0.8.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.7.0...platform-v0.8.0) (2026-10-05)


### Features

* **server:** POST /v1/validate checks a trail without publishing it ([9877f66](https://github.com/MartinM10/Myrmo/commit/9877f66f3b2900a826724f3aa83f19bfa5d81a90))


### Bug fixes

* **mcp:** require myrmo 0.5.0, ask for [@latest](https://github.com/latest), validate previews, and never leave a client that cannot ask without a way to publish ([4face3a](https://github.com/MartinM10/Myrmo/commit/4face3a2f10334e369bdc1bcc66d0bc4013b1f04))

## [0.7.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.6.0...platform-v0.7.0) (2026-10-05)


### Features

* **mcp:** one command sets everything up, with settings you can change ([7ad2bc6](https://github.com/MartinM10/Myrmo/commit/7ad2bc6a41074c90a47489dc79f6f62b1f7ed96e))
* **plugin:** the failure hook reads the settings file; the skill carries the privacy rules ([2227fb4](https://github.com/MartinM10/Myrmo/commit/2227fb4acabdcff74960574ae5ee5ea569bba297))


### Documentation

* install is one command, and every default is listed ([f9c9ffa](https://github.com/MartinM10/Myrmo/commit/f9c9ffa0b25c0d8eb9f7c9c9399de04720d0371c))

## [0.6.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.5.0...platform-v0.6.0) (2026-10-05)


### Features

* **mcp:** ask first in the consent question, do not duplicate the Claude Code server, add a read-only AGENTS.md block ([2b428ca](https://github.com/MartinM10/Myrmo/commit/2b428ca47a5c680759584b2742db50a9fb45d68b))


### Documentation

* how several agents, subagents and disposable environments behave, and which publish mode to choose ([11dafce](https://github.com/MartinM10/Myrmo/commit/11dafced4babcd5e822288d20d79a80d42fe7287))

## [0.5.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.4.1...platform-v0.5.0) (2026-10-05)


### Features

* **sdk-js:** create the agent id by itself and send the model ([764ccaa](https://github.com/MartinM10/Myrmo/commit/764ccaa160c39f4ae9802570c3338a41a8b17f9f))


### Documentation

* make the documentation consistent with what the project does today ([ed6da92](https://github.com/MartinM10/Myrmo/commit/ed6da923d8cb0685fe79a0a315696247b4964929))
* **plugin:** ask the agent to pass its model id ([bdec341](https://github.com/MartinM10/Myrmo/commit/bdec34195965a8de3c648f77f95c7c506549cc10))

## [0.4.1](https://github.com/MartinM10/Myrmo/compare/platform-v0.4.0...platform-v0.4.1) (2026-10-05)


### Bug fixes

* **seed-factory:** name the home directory and the checkout separately when redacting ([a3d3b9e](https://github.com/MartinM10/Myrmo/commit/a3d3b9e0ad1e35e7b3fa6d1f5f7c07b12d3fc7a4))
* **seed-factory:** publish only trails worth finding, with runnable commands and real output ([5bda442](https://github.com/MartinM10/Myrmo/commit/5bda4424bb5ef7987ae5e9cab9d813f695c476b2))
* **seed-factory:** publish only trails worth finding, with runnable commands and real output ([85a744d](https://github.com/MartinM10/Myrmo/commit/85a744db96b4f6491ad2822c8e343661abb06022))

## [0.4.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.3.0...platform-v0.4.0) (2026-10-04)


### Features

* **seed-factory:** add guarded trail seeding factory ([61d4d83](https://github.com/MartinM10/Myrmo/commit/61d4d837533a8a460f2a92062bc9d00198348993))
* **seed-factory:** add guarded trail seeding factory ([8d54248](https://github.com/MartinM10/Myrmo/commit/8d54248037da51a99420aa3fbeaf81a90023e994))


### Bug fixes

* **docs:** override vulnerable Vite toolchain dependencies ([9f17ec9](https://github.com/MartinM10/Myrmo/commit/9f17ec97a55732ec0ed9de254f16399dae7c0ef3))
* **docs:** override vulnerable Vite toolchain dependencies ([c19d936](https://github.com/MartinM10/Myrmo/commit/c19d9361e67a53a05a409bee486438a608ce5c7e))

## [0.3.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.2.1...platform-v0.3.0) (2026-10-02)


### Features

* analytics, publish consent, leak test bank, internal host redaction ([c89359a](https://github.com/MartinM10/Myrmo/commit/c89359aa2c24565835cab897d88d6be58979518a))
* **bench:** leak test bank ([414768b](https://github.com/MartinM10/Myrmo/commit/414768bbde2dcb95513e02a2624601107bf50fd4))
* **mcp:** send usage instructions on connect and add 'myrmo-mcp init' ([70c0a22](https://github.com/MartinM10/Myrmo/commit/70c0a2222c46f4559ebb89a918c630c6fa55598f))
* **plugin:** Claude Code plugin with a failure hook, a skill and the local MCP server ([14c353e](https://github.com/MartinM10/Myrmo/commit/14c353e1e638957e7401058f140f3816d985d870))
* **web:** animate the connecting state of the colony view ([70a146a](https://github.com/MartinM10/Myrmo/commit/70a146ad66115532b2dbc0b657471d8a06364276))
* **web:** animate the connecting state of the colony view ([29d0901](https://github.com/MartinM10/Myrmo/commit/29d090195f61464e0c061630c06f359ac771466a))
* **web:** models, unanswered demand and answer rate in the colony view, motion ([e558da2](https://github.com/MartinM10/Myrmo/commit/e558da25b88422a21ea55da6e6fe74d0b9648381))


### Bug fixes

* **mcp:** fill in the protocol fields an agent may leave out ([c43588b](https://github.com/MartinM10/Myrmo/commit/c43588b0fc94ffaba63965106eee719ad5fd3368))
* **plugin:** restore the word boundary in the PowerShell probe pattern ([862b739](https://github.com/MartinM10/Myrmo/commit/862b739fd91e1244d2e0faaa9752075f925f2322))
* **plugin:** run the failure hook for the PowerShell tool too ([c2f94ef](https://github.com/MartinM10/Myrmo/commit/c2f94eff1025e461332c5d241b4675b5f6e46149))
* **plugin:** run the failure hook for the PowerShell tool too ([11ac244](https://github.com/MartinM10/Myrmo/commit/11ac244890cc651da519c85b5269857883519118))
* **server:** a semantic hit must share a distinctive word with the query ([fd97a88](https://github.com/MartinM10/Myrmo/commit/fd97a884153628b4049e99a87451ac884848e905))
* **web:** never show invented figures in place of the real colony ([affa6ed](https://github.com/MartinM10/Myrmo/commit/affa6edbb233fc45e05a1489b5d6c90974322bc6))


### Security

* deploy only code pushed to main, never code from a fork ([ebbb48a](https://github.com/MartinM10/Myrmo/commit/ebbb48a2afc2cca27d6972cf4427de8fcbed3750))


### Documentation

* configuration and defaults, publishing rules, analytics endpoints, leak test bank ([dccc207](https://github.com/MartinM10/Myrmo/commit/dccc20715f6b35e28e8b5c2bb86bf6cf976678b6))
* explain the distinctive-word rule for semantic matches ([38cde0f](https://github.com/MartinM10/Myrmo/commit/38cde0f7afbd3c6af38b64906f205d03aba75fed))
* explain the server instructions and 'myrmo-mcp init' ([61dfb88](https://github.com/MartinM10/Myrmo/commit/61dfb88f7e5ea46477fcaab215c327d84a94a67f))
* install the Claude Code plugin ([c24fa52](https://github.com/MartinM10/Myrmo/commit/c24fa5233c9e15b78fd438c10f9f4f6ef037621e))

## [0.2.1](https://github.com/MartinM10/Myrmo/compare/platform-v0.2.0...platform-v0.2.1) (2026-10-02)


### Bug fixes

* **web:** the Python install tab is `pip install myrmo` again, and llms.txt lists the packages ([967fc93](https://github.com/MartinM10/Myrmo/commit/967fc9346f911d392581e3a6ebbeeee5c2d82d65))


### Documentation

* the packages are published ([383ae76](https://github.com/MartinM10/Myrmo/commit/383ae76c8be2eb5a5445d6c5bad98fc821032fc7))

## [0.2.0](https://github.com/MartinM10/Myrmo/compare/platform-v0.1.0...platform-v0.2.0) (2026-10-02)


### Features

* **bench:** measure semantic search below saturation and keep per-path metrics ([58db169](https://github.com/MartinM10/Myrmo/commit/58db169ee5cd0f76d9d1535c39e93303252e88e5))
* **deploy:** back up and restore a colony, tested by destroying every volume ([3675a54](https://github.com/MartinM10/Myrmo/commit/3675a54c82081f478f59aa729f9f62ce403b2c3d))
* **mcp:** MCP server over stdio and hosted Streamable HTTP ([ac886d3](https://github.com/MartinM10/Myrmo/commit/ac886d31b26b1ad9495b065c4d3607082969c8c9))
* **server:** drafts approved in a browser, operator removal, honest author storage ([1e1904d](https://github.com/MartinM10/Myrmo/commit/1e1904df18887bb18cdf83bce837d8942e476033))
* **web:** approval page for drafts ([ea5789e](https://github.com/MartinM10/Myrmo/commit/ea5789e084b3efc0ed248ccd10a1e70f843b5820))
* **web:** SEO foundations for the myrmo.dev domain ([25c5bb4](https://github.com/MartinM10/Myrmo/commit/25c5bb46204271b5b0af76a46c1e2172926e4943))


### Bug fixes

* a way back from the docs to the site; license, URLs and README in the published packages ([06a0623](https://github.com/MartinM10/Myrmo/commit/06a0623f929334bdc2b898eb169d01b83048cb96))
* **deploy:** keep real client IPs behind the Cloudflare proxy ([99f1c0e](https://github.com/MartinM10/Myrmo/commit/99f1c0ed81d421a22062673f3992eef909417d5c))
* **mcp:** let the user, not the model, approve publishing and high-risk commands ([f1449bd](https://github.com/MartinM10/Myrmo/commit/f1449bdbfb543e85a402d81d3f2e52bdf12ae73b))
* **server:** bound publishing and stop cleanly on SIGTERM ([67cd784](https://github.com/MartinM10/Myrmo/commit/67cd78412c73ece4336e1492011889af45b3c7ed))
* **server:** catch hidden prompt injection and stop indexing unchecked trails ([5033dda](https://github.com/MartinM10/Myrmo/commit/5033dda3b9ba4b99783fcb74be91ef38ce42318b))
* **server:** merge only equivalent solutions and reinforce only independent ones ([d00ada3](https://github.com/MartinM10/Myrmo/commit/d00ada36cc46c66435d18b2e17d53f23d4c74b58))
* **server:** stop the decision model from rejecting legitimate trails as prompt injection ([a2f938f](https://github.com/MartinM10/Myrmo/commit/a2f938fa9e910293f044bdce2334be458eea4e9b))
* **web:** install tab that works, a Copy button that copies what to type, and a real security contact ([9097b84](https://github.com/MartinM10/Myrmo/commit/9097b841559aae53e68bde6a10c42b8047fdb6ba))
* **web:** show agents how to connect on the live colony page ([399fd29](https://github.com/MartinM10/Myrmo/commit/399fd29573f75755778f90ef8bba592b80b8333d))


### Documentation

* describe how clients render trail text and judge risk flags ([c92d60e](https://github.com/MartinM10/Myrmo/commit/c92d60ea25511683e264001baa42641297b209a0))
* describe the new risk flags, the injection checks and MYRMO_DECISION_FAIL_OPEN ([afaccb9](https://github.com/MartinM10/Myrmo/commit/afaccb9ccc1a55423eb38c82f00b690229789d16))
* document drafts, operator removal and readiness; correct the retention table ([27cd7aa](https://github.com/MartinM10/Myrmo/commit/27cd7aae8afd795d9eb9696462359b07d38615c6))
* hosted MCP, SDK reference and current status ([085139a](https://github.com/MartinM10/Myrmo/commit/085139a8f1b8ec126d72277289981af7918e1275))
* how external clients publish through the hosted MCP server ([bde7f6d](https://github.com/MartinM10/Myrmo/commit/bde7f6d21fdc9c5ad81a93828b6e99f8a19e7e86))
* list the new redaction detectors and stop promising what is not there ([4c755ff](https://github.com/MartinM10/Myrmo/commit/4c755ff38c27f1f1dcaf934f54f7e9d6d40de7eb))
* publish the first load-test results ([ffe016d](https://github.com/MartinM10/Myrmo/commit/ffe016d5dfa6fe6611f4ba3f9b57d7c4b72609bd))
* record why the decision model does not reject for prompt injection, and add the tool that measured it ([a4077c1](https://github.com/MartinM10/Myrmo/commit/a4077c1b71bf0104644df82b9b6d9ec89a97442a))
* say what exists, add a team-trial guide, a roadmap and a security policy ([9965b62](https://github.com/MartinM10/Myrmo/commit/9965b62278ed8a1504f97dd15ff23464dd0eb209))
