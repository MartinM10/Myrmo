# Changelog

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
