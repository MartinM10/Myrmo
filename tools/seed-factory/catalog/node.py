from .probes import from_probe

NODE20 = {"name": "node", "version": "20"}
NODE22 = {"name": "node", "version": "22"}

TASKS = (
    from_probe(
        "node-esm-json-import-attribute", category="api_contract", error_type="ERR_IMPORT_ATTRIBUTE_MISSING", runtime=NODE22,
        summary="Node 22 requires an import attribute to load a JSON file from an ES module, so import data from './x.json' fails with ERR_IMPORT_ATTRIBUTE_MISSING.",
        context="Running an ES module on Node 22 that imports a JSON file the way bundlers allow.",
        failed_approaches=("cd /w && node --experimental-json-modules a.mjs 2>&1", "cd /w && node --input-type=module -e \"import d from './x.json'; console.log(d)\" 2>&1"),
        fix="cd /w && printf \"import d from './x.json' with { type: 'json' };\\nconsole.log(d);\\n\" > a.mjs", verify="cd /w && node a.mjs",
        root_cause="Node follows the import attributes proposal: a module of type JSON must be declared as JSON with `with { type: 'json' }`, so that a server cannot make an import run code by serving a different content type. The old --experimental-json-modules flag no longer changes this.",
        steps=("Add `with { type: 'json' }` to the import.", "Older Node 20 releases used `assert { type: 'json' }`; use `with` on Node 22 and later.", "Or read the file with fs.readFileSync and JSON.parse."),
        tags=("node", "esm", "json", "node22"), message="needs an import attribute",
    ),
    from_probe(
        "node-jest30-testpathpattern", category="tooling", error_type="Option testPathPattern was replaced", runtime=NODE20, memory="1g",
        summary="Jest 30 renamed --testPathPattern to --testPathPatterns, so a script that passes the old option stops before running any test.",
        context="A CI script or an npm script such as `jest --testPathPattern src/` after upgrading to Jest 30.",
        failed_approaches=("cd /w && npx jest --testPathPattern=a 2>&1", "cd /w && npx jest -t a --testPathPattern a 2>&1"),
        fix="cd /w && npx jest --testPathPatterns a", verify="cd /w && npx jest --testPathPatterns a --passWithNoTests",
        root_cause="Jest 30 accepts several patterns, so the option became plural and the old spelling is rejected with an explanatory error instead of being ignored.",
        steps=("Rename --testPathPattern to --testPathPatterns.", "Positional patterns (`jest src/`) keep working and need no change."),
        tags=("node", "jest", "jest30", "cli-option"), message="was replaced by",
    ),
    from_probe(
        "node-pnpm10-ignored-build-sqlite3", category="tooling", error_type="Could not locate the bindings file", runtime=NODE20, memory="1g",
        summary="pnpm 10 does not run dependency install scripts by default, so native modules such as sqlite3 are installed without their compiled binding and fail on require.",
        context="Installing a project that depends on sqlite3, bcrypt, sharp or esbuild with pnpm 10 and then running it.",
        failed_approaches=("cd /w && pnpm install --force >/dev/null 2>&1; node -e \"require('sqlite3')\" 2>&1", "cd /w && pnpm add sqlite3@5.1.7 >/dev/null 2>&1; node -e \"require('sqlite3')\" 2>&1"),
        fix="cd /w && node -e \"const fs=require('fs');const p=require('./package.json');p.pnpm={onlyBuiltDependencies:['sqlite3']};fs.writeFileSync('package.json',JSON.stringify(p,null,2))\" && pnpm rebuild sqlite3",
        verify="cd /w && node -e \"require('sqlite3'); console.log('sqlite3 loaded')\"",
        root_cause="Since pnpm 10 the lifecycle scripts of dependencies do not run unless the package is listed in onlyBuiltDependencies (or approved with pnpm approve-builds). A native module whose install script downloads or compiles its binding is left without it.",
        steps=("Add the package to `pnpm.onlyBuiltDependencies` in package.json (or run pnpm approve-builds).", "Run pnpm rebuild <package> so the script runs.", "Commit the setting so CI does the same."),
        tags=("node", "pnpm", "pnpm10", "native-module", "install-scripts"), message="Could not locate the bindings file",
    ),
    from_probe(
        "node-tailwind4-postcss", category="build", error_type="PostCSS plugin", runtime=NODE20, memory="1g",
        summary="Tailwind CSS 4 moved its PostCSS plugin to the separate @tailwindcss/postcss package, so a postcss.config that names tailwindcss fails with an error telling you so.",
        context="Upgrading a project from Tailwind 3 to Tailwind 4 that builds its CSS with PostCSS.",
        extra_setup="cd /w && echo '@import \"tailwindcss\";' > in.css",
        failed_approaches=("cd /w && npx tailwindcss -i in.css 2>&1", "cd /w && npx tailwindcss init -p 2>&1"),
        fix="cd /w && npm i -s @tailwindcss/postcss && echo 'module.exports={plugins:{\"@tailwindcss/postcss\":{}}}' > postcss.config.js", verify="cd /w && npx postcss in.css | head -n 3",
        root_cause="Tailwind 4 split its integrations into their own packages: @tailwindcss/postcss for PostCSS, @tailwindcss/cli for the command line and @tailwindcss/vite for Vite. The tailwindcss package itself is no longer a PostCSS plugin and no longer ships the init command.",
        steps=("Install @tailwindcss/postcss.", "Use it in postcss.config as the plugin name instead of tailwindcss (and drop autoprefixer: v4 handles prefixes).", "Replace the @tailwind directives with @import \"tailwindcss\"."),
        tags=("node", "tailwind", "tailwind4", "postcss"), message="directly as a PostCSS plugin",
    ),
    from_probe(
        "node-corepack-keyid", category="tooling", error_type="Cannot find matching keyid", runtime=NODE22, memory="1g",
        summary="Corepack releases before 0.31 cannot verify the signature of newly published package manager versions, because npm rotated its signing keys, and fail with Cannot find matching keyid.",
        context="Running corepack prepare or any pnpm/yarn command through Corepack on a Node image from before 2025.",
        failed_approaches=("corepack prepare pnpm@latest --activate 2>&1", "corepack enable && corepack pnpm --version 2>&1"),
        fix="npm install -g corepack@latest >/dev/null 2>&1 && corepack prepare pnpm@latest-10 --activate", verify="corepack --version && corepack pnpm --version",
        root_cause="Corepack checks the npm registry signatures of the package managers it downloads against keys it has built in. npm rotated its keys in early 2025, and the older Corepack that ships with a Node release does not know the new ones.",
        steps=("Update Corepack: npm install -g corepack@latest.", "As a stopgap, set COREPACK_INTEGRITY_KEYS=0 for the command; that turns the signature check off, so prefer the update.", "Use a Node image that bundles Corepack 0.31 or newer."),
        tags=("node", "corepack", "pnpm", "signature"), message="Cannot find matching keyid",
    ),
)

TASKS += (
    from_probe(
        "node-eslint-plugin-missing", category="dependency", error_type="ESLint couldn't find the plugin", runtime=NODE20, memory="1g",
        summary="ESLint 8 fails with couldn't find the plugin when the config lists a plugin that is not installed in the project, because plugins are not installed with ESLint.",
        context="Running eslint in a fresh clone or a CI job whose config names plugins (react, import) that are not in node_modules.",
        failed_approaches=("cd /w && npx eslint --resolve-plugins-relative-to . . 2>&1", "cd /w && npm i -s eslint-plugin-react-hooks >/dev/null 2>&1; npx eslint . 2>&1"),
        fix="cd /w && npm i -s eslint-plugin-react", verify="cd /w && npx eslint .",
        root_cause="A plugin is an ordinary npm package that the project must depend on. The config only names it; ESLint loads it from node_modules and stops with the exact package name it did not find.",
        steps=("Install the package named in the message as a devDependency (npm i -D eslint-plugin-react).", "Install the plugin in the same place as ESLint: a global ESLint does not see local plugins unless --resolve-plugins-relative-to is set.", "Keep it in package.json so CI installs it."),
        tags=("node", "eslint", "eslint8", "plugins"), message="couldn't find the plugin",
    ),
    from_probe(
        "node-prisma-openssl-slim", category="platform", error_type="PrismaClientInitializationError", runtime=NODE20, memory="2g",
        summary="Prisma Client cannot load its query engine in a node slim image, failing on libssl.so.1.1, because the image has no OpenSSL for the engine to link to.",
        context="Running a Prisma app in a Docker image based on node:slim (or any image without openssl).",
        failed_approaches=("""cd /w && PRISMA_QUERY_ENGINE_LIBRARY=/nonexistent node -e "require('@prisma/client'); new (require('@prisma/client').PrismaClient)().\\$connect().catch((e) => { console.error(e.message); process.exit(1) })" 2>&1""", """cd /w && npx prisma generate --schema schema.prisma >/dev/null 2>&1; npx prisma db pull --schema schema.prisma 2>&1"""),
        fix="""apt-get update -y >/dev/null && apt-get install -y openssl >/dev/null && cd /w && npx prisma generate --schema schema.prisma >/dev/null 2>&1""",
        verify="""cd /w && node -e "const { PrismaClient } = require('@prisma/client'); new PrismaClient().\\$connect().then(() => { console.log('connected'); process.exit(0) })" """,
        root_cause="Prisma's query engine is a native library built for a specific OpenSSL. Slim images ship without openssl, so Prisma cannot detect which version to use, falls back to 1.1.x and then cannot load it.",
        steps=("Install openssl in the image (apt-get install -y openssl), then run prisma generate again.", "Or use a non-slim base image, or one that already has OpenSSL.", "Add the matching binaryTargets to the generator block if you build on one platform and run on another."),
        tags=("node", "prisma", "docker", "openssl"), message="Unable to require",
    ),
)

TASKS += (
    from_probe(
        "node-typescript-module-nodenext-mismatch", category="configuration", error_type="TS5110", runtime=NODE20, memory="1g",
        summary="TypeScript 5.2 and later require module to be NodeNext whenever moduleResolution is NodeNext, and tsc stops with TS5110 when tsconfig sets them differently.",
        context="Running tsc after setting moduleResolution to nodenext (or upgrading a config) while module stayed esnext.",
        failed_approaches=("cd /w && npx tsc --noEmit --moduleResolution node16 2>&1", "cd /w && npx tsc --noEmit --skipLibCheck 2>&1"),
        fix="""cd /w && sed -i 's/"module":"esnext"/"module":"nodenext"/' tsconfig.json""", verify="cd /w && npx tsc --noEmit && echo compiled",
        root_cause="The Node-style module resolution modes (node16, nodenext) define how the code is emitted as well as how imports are found, so TypeScript checks that module matches them instead of letting the two disagree.",
        steps=("Set module to NodeNext (or Node16) together with moduleResolution.", "If you bundle the code, use moduleResolution bundler with module esnext or preserve instead."),
        tags=("typescript", "tsconfig", "nodenext", "ts5110"), message="error TS5110",
    ),
    from_probe(
        "node-typescript-nodenext-import-extension", category="build", error_type="TS2835", runtime=NODE20, memory="1g",
        summary="With module nodenext, TypeScript requires relative imports in ECMAScript modules to carry the file extension, and tsc reports TS2835 for an import written without .js.",
        context="Compiling a project that moved to ES modules (type: module) and the nodenext setting.",
        failed_approaches=("""cd /w && echo "import { a } from './a.ts'; console.log(a);" > b.ts && npx tsc 2>&1""", "cd /w && npx tsc --moduleResolution bundler 2>&1"),
        fix="""cd /w && echo "import { a } from './a.js'; console.log(a);" > b.ts""", verify="cd /w && npx tsc && echo compiled",
        root_cause="Node's ES module loader does not guess extensions, so under nodenext TypeScript demands the path that will exist at run time: the emitted .js file, even though the source is a.ts.",
        steps=("Write the .js extension in the import (./a.js); TypeScript maps it to a.ts.", "Do not write .ts unless allowImportingTsExtensions is on and you do not emit.", "A bundler handles extensions itself: with one, moduleResolution bundler removes the requirement."),
        tags=("typescript", "esm", "nodenext", "ts2835"), message="error TS2835",
    ),
)
