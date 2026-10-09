from .probes import from_probe

GO122 = {"name": "go", "version": "1.22.5"}

TASKS = (
    from_probe(
        "go-toolchain-local-too-new", category="tooling", error_type="requires go", runtime=GO122, memory="2g",
        summary="A go.mod that asks for a newer Go than the installed one stops the build when automatic toolchain download is switched off (GOTOOLCHAIN=local), as it is in many CI images.",
        context="Building a module whose go directive was raised to 1.24 on a machine that has Go 1.22.",
        failed_approaches=("cd /w && GOTOOLCHAIN=local go mod edit -go=1.24.0 && GOTOOLCHAIN=local go build ./... 2>&1", "cd /w && GOTOOLCHAIN=local GOFLAGS=-mod=mod go build ./... 2>&1"),
        fix="cd /w && GOTOOLCHAIN=auto go build ./...", verify="cd /w && GOTOOLCHAIN=auto go version",
        root_cause="Since Go 1.21 the go line of go.mod is a minimum. With GOTOOLCHAIN=auto the go command downloads the toolchain it needs; with local it refuses and reports the version it requires.",
        steps=("Use a Go at least as new as the go.mod line, or let the go command download it (GOTOOLCHAIN=auto, the default).", "If the module does not need the new language version, lower the go directive.", "In Docker, base the image on the Go version go.mod names."),
        tags=("go", "gotoolchain", "go.mod"), message="requires go >=",
    ),
    from_probe(
        "go-cgo-alpine-no-gcc", category="build", error_type="cgo: C compiler gcc not found", runtime={"name": "go", "version": "1.23"}, memory="2g",
        summary="Building a Go program that uses cgo on the golang alpine image fails because the image has no C compiler.",
        context="A Dockerfile that builds with golang:alpine and a dependency that needs cgo (sqlite3, a C library binding).",
        failed_approaches=("cd /w && CGO_ENABLED=1 go build -tags netgo ./... 2>&1", "cd /w && go env -w CC=clang && CGO_ENABLED=1 go build ./... 2>&1"),
        fix="apk add --no-cache gcc musl-dev >/dev/null && cd /w && CGO_ENABLED=1 go build ./...", verify="cd /w && CGO_ENABLED=1 go build ./... && echo built",
        root_cause="The golang:alpine image is minimal and ships no gcc. cgo calls the C compiler and the C library headers, which on Alpine are gcc and musl-dev.",
        steps=("Install gcc and musl-dev in the build stage: apk add --no-cache gcc musl-dev.", "Or avoid cgo: CGO_ENABLED=0, with a pure-Go driver or library.", "Use a multi-stage build so the compiler stays out of the final image."),
        tags=("go", "cgo", "alpine", "docker"), message='cgo: C compiler "gcc" not found',
    ),
)

TASKS += (
    from_probe(
        "go-private-module-no-credentials", category="authentication", error_type="terminal prompts disabled", runtime=GO122, memory="2g",
        summary="go install of a GitHub module fails with could not read Username when the path is mistyped or the repository is private, because GitHub asks for credentials and git is told never to prompt.",
        context="Installing a Go tool from GitHub with a path that has one letter wrong, or a private repository without credentials configured.",
        failing="go install github.com/rakyl/hey@latest 2>&1",
        failed_approaches=("GOPROXY=direct go install github.com/rakyl/hey@latest 2>&1", "GOFLAGS=-mod=mod go install github.com/rakyl/hey@latest 2>&1"),
        fix="go install github.com/rakyll/hey@v0.1.4", verify="ls $(go env GOPATH)/bin/hey",
        root_cause="For a repository that does not exist or that you may not read, GitHub answers a request with an authentication challenge instead of 404. The go command runs git with terminal prompts disabled, so the challenge shows up as could not read Username.",
        steps=("Check the module path for typos before anything else: the same message appears for a repository that does not exist.", "For a private repository, set GOPRIVATE for its prefix and give git credentials (a token through a netrc file or git config url.<base>.insteadOf).", "Do not disable the module proxy to work around it."),
        tags=("go", "github", "goprivate", "git"), message="could not read Username",
    ),
)

TASKS += (
    from_probe(
        "go-vendor-inconsistent", category="dependency", error_type="inconsistent vendoring", runtime=GO122, memory="2g",
        summary="go build fails with inconsistent vendoring when go.mod was changed (a version bumped or edited) but the vendor directory was not regenerated.",
        context="Building a module that commits its vendor directory after a dependency version was changed in go.mod.",
        failed_approaches=("cd /w && go build -mod=vendor ./... 2>&1", "cd /w && go mod tidy && go build -mod=vendor ./... 2>&1"),
        fix="cd /w && go mod tidy && go mod vendor && go build ./...", verify="cd /w && go build ./... && echo built",
        root_cause="When a vendor directory exists the go command builds from it and checks that vendor/modules.txt matches go.mod. Editing go.mod without running go mod vendor leaves them disagreeing, and neither go mod tidy nor -mod=vendor reconciles them.",
        steps=("Run go mod vendor and commit the updated vendor directory.", "To ignore the directory for one build, use -mod=mod.", "Run go mod vendor in CI and fail when git diff shows changes, to catch it early."),
        tags=("go", "vendor", "go.mod"), message="inconsistent vendoring",
    ),
)

TASKS += (
    from_probe(
        "go-generics-old-language-version", category="build", error_type="type parameter requires go1.18 or later", runtime=GO122, memory="2g",
        summary="Go reports that type parameters need go1.18 or later when go.mod still declares an older language version, even though the installed toolchain is recent.",
        context="Building a module whose go directive was never raised, after adding code that uses generics.",
        failed_approaches=("cd /w && go vet ./... 2>&1", "cd /w && go build -gcflags=-G=3 ./... 2>&1"),
        fix="cd /w && go mod edit -go=1.22 && go build ./...", verify="cd /w && go build ./... && echo built",
        root_cause="The go line of go.mod selects the language version the compiler accepts for the module (-lang). A module that says go 1.16 is compiled as Go 1.16 whatever toolchain builds it, and generics arrived in 1.18.",
        steps=("Raise the go directive: go mod edit -go=1.22 (or the version you build with).", "Check that the code still builds: the language version also changes loop variable semantics from 1.22."),
        tags=("go", "generics", "go.mod", "language-version"), message="type parameter requires go1.18 or later",
    ),
    from_probe(
        "go-replace-directory-missing", category="dependency", error_type="replacement directory does not exist", runtime=GO122, memory="2g",
        summary="go build fails with replacement directory does not exist when go.mod has a replace directive that points at a local path missing on this machine, as in a fresh clone or a CI job.",
        context="Building a module that was developed with a replace to a sibling checkout (../lib) that is not present.",
        failed_approaches=("cd /w && go mod tidy 2>&1", "cd /w && go mod download 2>&1"),
        fix="cd /w && go mod edit -dropreplace github.com/google/uuid && go mod tidy && go build ./...", verify="cd /w && go build ./... && echo built",
        root_cause="A replace directive that names a directory takes precedence over the published module, so the build needs that directory. It exists only on the machine of whoever wrote the line.",
        steps=("Remove the replace (go mod edit -dropreplace <module>) and depend on a published version, or", "check out the sibling repository at the expected relative path, or use a go.work file for local development instead of committing a replace."),
        tags=("go", "go.mod", "replace", "ci"), message="replacement directory",
    ),
)

TASKS += (
    from_probe(
        "go-build-no-go-mod", category="tooling", error_type="go.mod file not found", runtime=GO122, memory="2g",
        summary="go build fails with go.mod file not found in current directory or any parent directory when the folder holds Go files but no module was initialised.",
        context="Building a new folder of Go files, or running go build in a subfolder of a checkout that has no go.mod above it.",
        failed_approaches=("cd /w && go mod tidy 2>&1", "cd /w && GO111MODULE=on go build 2>&1"),
        fix="cd /w && go mod init example.com/app && go build", verify="cd /w && go build && echo built",
        root_cause="Since Go 1.16 the go command works in module mode only and needs a go.mod to know the module path and the dependencies. go mod tidy also needs it, and turning module mode on explicitly does not create one.",
        steps=("Run go mod init <module path> in the project root, then go mod tidy.", "If a go.mod exists, run the command from inside that module, not from a folder outside it."),
        tags=("go", "go.mod", "modules"), message="go.mod file not found",
    ),
    from_probe(
        "go-import-cycle", category="build", error_type="import cycle not allowed", runtime=GO122, memory="2g",
        summary="go build fails with import cycle not allowed when two packages import each other, directly or through a third one.",
        context="Adding an import between two packages of the same module, often to reuse a type or a helper.",
        failed_approaches=("cd /w && go build -gcflags=-e ./... 2>&1", "cd /w && go mod tidy && go build ./... 2>&1"),
        fix="cd /w && printf 'package b\n' > b/b.go && go build ./...", verify="cd /w && go build ./... && echo built",
        root_cause="Go compiles packages in dependency order and has no way to compile two packages that need each other first. The cycle is in the code, so compiler flags and go mod tidy cannot resolve it.",
        steps=("Read the chain printed under the error to see which import closes the cycle.", "Move the shared types or functions into a third package that both import, or invert one dependency with an interface defined where it is used."),
        tags=("go", "packages", "imports"), message="import cycle not allowed",
    ),
)

TASKS += (
    from_probe(
        "go-sqlite3-cgo-disabled", category="build", error_type="requires cgo to work", runtime=GO122, memory="2g",
        summary="A Go program that uses mattn/go-sqlite3 starts and prints Binary was compiled with CGO_ENABLED=0, go-sqlite3 requires cgo to work, because it was built without cgo.",
        context="Building a static binary for a scratch or Alpine image with CGO_ENABLED=0, and running a program that opens a SQLite database through go-sqlite3.",
        failed_approaches=("cd /w && CGO_ENABLED=0 go build -tags sqlite_omit_load_extension -o app . && ./app 2>&1", """cd /w && CGO_ENABLED=0 go build -ldflags="-s -w" -o app . && ./app 2>&1"""),
        fix="cd /w && CGO_ENABLED=1 go build -o app . && ./app", verify="cd /w && CGO_ENABLED=1 go build -o app . && ./app",
        root_cause="go-sqlite3 wraps the C SQLite library, so it needs cgo and a C compiler at build time. With CGO_ENABLED=0 the package compiles a stub that only reports this error at run time, and build tags or linker flags do not bring the C code back.",
        steps=("Build with cgo: CGO_ENABLED=1 and a C compiler in the build image (gcc, and musl-dev on Alpine); link statically with -ldflags '-linkmode external -extldflags -static' if the image has no libc.", "Or use a pure Go SQLite driver (modernc.org/sqlite) and keep CGO_ENABLED=0."),
        tags=("go", "sqlite", "cgo", "docker", "static-binary"), message="requires cgo to work",
    ),
)
