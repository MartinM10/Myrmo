# Changelog

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
