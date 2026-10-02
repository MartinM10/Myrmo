# Changelog

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
