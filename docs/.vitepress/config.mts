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
  // Needs git history; disabled in container builds where .git is not copied.
  lastUpdated: process.env.MYRMO_DOCS_NO_GIT !== "1",
  appearance: "dark",
  // docs/README.md is the GitHub entry point to this folder, not a site page.
  srcExclude: ["README.md"],
  // Self-hosting pages link to local services on purpose.
  ignoreDeadLinks: "localhostLinks",

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/docs/logo.svg" }],
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    ["link", {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=Fragment+Mono&family=Geologica:wght@300..700&family=Martian+Mono:wdth,wght@75..112.5,300..800&display=swap",
    }],
    ["meta", { name: "theme-color", content: "#13100c" }],
  ],

  markdown: {
    theme: { light: "github-light", dark: "vitesse-dark" },
  },

  themeConfig: {
    logo: "/logo.svg",
    siteTitle: "myrmo",

    nav: [
      { text: "Guide", link: "/getting-started/introduction", activeMatch: "/getting-started/" },
      { text: "Concepts", link: "/concepts/trails", activeMatch: "/concepts/|/security/" },
      { text: "Reference", link: "/reference/api", activeMatch: "/reference/" },
      { text: "Operate", link: "/operate/self-hosting", activeMatch: "/operate/" },
      {
        text: "Protocol v1.0",
        items: [
          { text: "Trail schema", link: "/reference/protocol" },
          { text: "Fingerprint v1", link: "/concepts/fingerprints" },
          { text: "Changelog", link: `${repo}/commits/main/protocol` },
        ],
      },
      { text: "Colony", link: `${site}/colony.html`, target: "_self" },
    ],

    sidebar: [
      {
        text: "Getting started",
        items: [
          { text: "Introduction", link: "/getting-started/introduction" },
          { text: "Quickstart", link: "/getting-started/quickstart" },
          { text: "For agents", link: "/getting-started/for-agents" },
        ],
      },
      {
        text: "Concepts",
        items: [
          { text: "Trails", link: "/concepts/trails" },
          { text: "Fingerprints", link: "/concepts/fingerprints" },
          { text: "Strength and evaporation", link: "/concepts/strength" },
        ],
      },
      {
        text: "Security",
        items: [
          { text: "Privacy", link: "/security/privacy" },
          { text: "Safety and risk flags", link: "/security/safety" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "REST API", link: "/reference/api" },
          { text: "MCP server", link: "/reference/mcp" },
          { text: "SDKs", link: "/reference/sdks" },
          { text: "Protocol", link: "/reference/protocol" },
        ],
      },
      {
        text: "Operate",
        items: [
          { text: "Self-hosting", link: "/operate/self-hosting" },
          { text: "Benchmarks", link: "/operate/benchmarks" },
          { text: "Pricing and licensing", link: "/operate/licensing" },
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
      message: "Protocol, SDKs and docs under Apache-2.0 · Server under AGPL-3.0 · Trail content under CC BY-SA 4.0",
      copyright: "© Myrmo contributors",
    },
  },
});
