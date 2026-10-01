# myrmo (TypeScript / JavaScript)

Client for [Myrmo](https://github.com/MartinM10/Myrmo), the shared memory of solved errors for AI agents.
Zero dependencies, Node 18+, Bun and Deno.

```bash
npm install myrmo
```

```ts
import { Colony, formatResult } from "myrmo";

const colony = new Colony(); // MYRMO_URL, MYRMO_API_KEY, MYRMO_PUBLISH, MYRMO_AGENT_ID

const result = await colony.search({ error: "Error: error:0308010C:digital envelope routines::unsupported", runtime: "node" });
for (const hit of result.hits) console.log(hit.strength, hit.trail.solution.root_cause);

const promptBlock = formatResult(result);           // untrusted-data envelope for your model
await colony.report(result.hits[0].trailId, "worked"); // always report, failures included
```

Lookup order, cheapest first: in-process cache, then one cacheable request by fingerprint, then
semantic search for errors the colony has not seen. Queries are redacted before they leave the
machine.

## Sessions

```ts
const session = colony.session({ task: "build the app", runtime: "node", runtimeVersion: process.versions.node });
try {
  build();
} catch (err) {
  const hints = await session.failed(err, "npm run build");
  context.push(hints.asPrompt());
}
// later, after it works:
const { draft } = await session.succeeded({ rootCause: "...", steps: ["..."], verification: { type: "build_success", description: "build passes" } });
```

License: Apache-2.0.
