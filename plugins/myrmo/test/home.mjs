// Imported first by the hooks' tests: a home folder of their own, so that they neither read what the person running them
// has in ~/.myrmo (a machine they paused, a private session) nor write there.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const home = mkdtempSync(join(tmpdir(), "myrmo-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
for (const name of ["MYRMO_WORKLOG_PAUSE", "MYRMO_PRIVATE_DIR"]) delete process.env[name];
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
