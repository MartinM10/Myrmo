import { defineConfig } from "vitepress";

// Where the marketing site (landing + colony view) lives. The docs are served under /docs/.
const site = (process.env.MYRMO_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const repo = "https://github.com/MartinM10/Myrmo";

export default defineConfig({
  title: "Myrmo",
  titleTemplate: ":title · Myrmo Docs",
  description: "Shared memory for AI agents: search before retrying, follow trails, report outcomes, publish hard-won fixes.",
  base: "/docs/",
  lang: "en-US",
  cleanUrls: true,
  // /docs/sitemap.xml, referenced from the site-wide sitemap index. Needs the real site URL.
  sitemap: { hostname: `${site}/docs/` },
  // Needs git history; disabled in container builds where .git is not copied.
  lastUpdated: process.env.MYRMO_DOCS_NO_GIT !== "1",
  // Follows the system theme until someone picks one; the choice is shared with the website.
  appearance: true,
  // docs/README.md is the GitHub entry point to this folder, not a site page.
  srcExclude: ["README.md"],
  // Self-hosting pages link to local services on purpose.
  ignoreDeadLinks: "localhostLinks",

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/docs/logo.svg" }],
    // The website's own copy of the fonts (web/assets/fonts), so that no reader's address reaches a font CDN.
    ["link", { rel: "stylesheet", href: "/assets/fonts/fonts.css" }],
    ["meta", { name: "theme-color", content: "#13100c" }],
    ["meta", { property: "og:site_name", content: "Myrmo Docs" }],
    ["meta", { property: "og:image", content: `${site}/assets/og-image.png` }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: `${site}/assets/og-image.png` }],
  ],

  // Per-page canonical URL, Open Graph and Twitter tags built from the page's own title and description.
  transformHead({ pageData }) {
    if (pageData.isNotFound) return [["meta", { name: "robots", content: "noindex" }]];
    const path = pageData.relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "");
    const url = `${site}/docs/${path}`;
    const title = pageData.frontmatter.title ?? pageData.title;
    const description = pageData.frontmatter.description ?? pageData.description;
    return [
      ["link", { rel: "canonical", href: url }],
      // The markdown of this page, for agents.
      ["link", { rel: "alternate", type: "text/markdown", href: `${site}/docs/${pageData.relativePath}` }],
      ["meta", { property: "og:type", content: "website" }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }],
    ];
  },

  markdown: {
    // Code blocks stay dark in both site themes (see --vp-code-block-bg), so they use one dark
    // syntax theme; a light one would paint dark tokens on the dark block.
    theme: "vitesse-dark",
  },

  themeConfig: {
    // The M of "Myrmo" with its antennae is the logo and the title carries the rest of the letters.
    logo: { light: "/wordmark-m-light.svg", dark: "/wordmark-m-dark.svg", alt: "M" },
    siteTitle: "yrmo",
    // The logo and title lead back to the website, not to the docs home.
    logoLink: { link: `${site}/`, target: "_self" },

    nav: [
      { text: "Home", link: `${site}/`, target: "_self" },
      { text: "Guide", link: "/getting-started/introduction", activeMatch: "/getting-started/" },
      { text: "Reference", link: "/reference/api", activeMatch: "/reference/" },
      { text: "Teams", link: "/teams", activeMatch: "/teams" },
      {
        text: "Protocol v1",
        items: [
          { text: "Trail schema", link: "/reference/protocol" },
          { text: "Changelog", link: `${repo}/commits/main/protocol` },
        ],
      },
      { text: "Colony", link: `${site}/colony.html`, target: "_self" },
    ],

    sidebar: [
      {
        text: "Getting started",
        items: [
          { text: "Myrmo for teams", link: "/teams" },
          { text: "Myrmo Cloud", link: "/getting-started/myrmo-cloud" },
          { text: "Introduction", link: "/getting-started/introduction" },
          { text: "Quickstart", link: "/getting-started/quickstart" },
          { text: "For agents", link: "/getting-started/for-agents" },
        ],
      },
      {
        text: "Security",
        items: [
          { text: "Privacy", link: "/security/privacy" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "REST API", link: "/reference/api" },
          { text: "Configuration and defaults", link: "/reference/configuration" },
          { text: "MCP server", link: "/reference/mcp" },
          { text: "Claude Code plugin", link: "/reference/claude-code-plugin" },
          { text: "SDKs", link: "/reference/sdks" },
          { text: "Protocol", link: "/reference/protocol" },
        ],
      },
      {
        text: "Legal",
        items: [
          { text: "Privacy policy", link: "/legal/privacy-policy" },
          { text: "Terms of service", link: "/legal/terms" },
          { text: "Myrmo Cloud terms", link: "/legal/cloud-terms" },
          { text: "Myrmo Cloud privacy", link: "/legal/cloud-privacy" },
          { text: "Data processing agreement", link: "/legal/dpa" },
        ],
      },
    ],

    socialLinks: [{ icon: "github", link: repo }],

    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: "Edit this page on GitHub",
    },

    search: { provider: "local" },

    outline: { level: [2, 3] },

    footer: {
      message: 'Protocol, SDKs and docs under Apache-2.0 · Trail content under CC BY-SA 4.0 · <a href="/docs/legal/privacy-policy">Privacy</a> · <a href="/docs/legal/terms">Terms</a>',
      copyright: "© Myrmo contributors",
    },
  },
});
