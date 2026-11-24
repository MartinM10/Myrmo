// A stand-in for the colony kit, for the tests: a folder laid out like an installed kit (a self-contained set of scripts,
// the package's own copies of the shared modules among them), whose agent scripts and tools do nothing of substance.
// The real kit is served by an organisation's colony and is not part of this package.

import { copyFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOOKS = fileURLToPath(new URL("../dist/hooks", import.meta.url));

/** The kit's scripts for each agent's work log hooks, as init copies them. */
export const KIT_AGENT_SCRIPTS = ["cline-hook.mjs", "gemini-hook.mjs", "antigravity-worklog.mjs"];

export const KIT_TEXT = "THE KIT'S OWN RULES\n- A line only the kit adds.";
/** The line the kit's copy of a shared module ends with. */
export const KIT_COPY = "// the kit's copy";

/** A kit folder: {version, dir}. `tools: false` leaves out mcp-tools.mjs, `text: false` instructions.md. */
export function fakeKit({ tools = true, text = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "myrmo-kit-"));
  for (const name of readdirSync(HOOKS)) copyFileSync(join(HOOKS, name), join(dir, name));
  // The kit's copy of a shared module is not the package's: a test can tell which one was installed.
  writeFileSync(join(dir, "lookup.mjs"), `${readFileSync(join(HOOKS, "lookup.mjs"), "utf8")}\n${KIT_COPY}\n`);
  for (const name of KIT_AGENT_SCRIPTS) writeFileSync(join(dir, name), "// a kit script\nexport {};\n");
  if (tools) {
    writeFileSync(
      join(dir, "mcp-tools.mjs"),
      `export function registerTools({ server, colony, z, text, finish }) {
  server.registerTool("kit_probe", { title: "Kit probe", description: "A tool the kit adds.", inputSchema: { word: z.string().max(20).optional() } }, async (args) => text(finish("probe " + (args.word ?? ""))));
  server.registerTool("kit_matters", { title: "Kit lookup", description: "A lookup the kit adds.", inputSchema: { query: z.string().optional() }, annotations: { readOnlyHint: true } }, async (args) => {
    await null;
    return text(JSON.stringify([args, await colony.listMatters({ q: args.query })]));
  });
  return ["kit_probe", "kit_matters"];
}
`,
    );
  }
  if (text) writeFileSync(join(dir, "instructions.md"), `${KIT_TEXT}\n`);
  return { version: "0.0.0-0123456789", dir };
}
