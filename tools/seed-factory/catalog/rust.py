from .probes import from_probe

RUST178 = {"name": "rust", "version": "1.78"}

TASKS = (
    from_probe(
        "rust-lockfile-v4-old-cargo", category="tooling", error_type="lock file version", runtime={"name": "rust", "version": "1.75"}, memory="2g",
        summary="A Cargo.lock written by a newer Cargo (lock file version 4) cannot be read by Cargo 1.75 or older, which stops with an error naming the lock file version.",
        context="Building in a container or CI image whose Rust is older than the one that last updated Cargo.lock.",
        failed_approaches=("cd /w && cargo update 2>&1", "cd /w && cargo build --locked 2>&1"),
        fix="cd /w && sed -i 's/^version = 4/version = 3/' Cargo.lock && cargo build", verify="cd /w && cargo build && echo built",
        root_cause="Cargo 1.78 started writing lock file version 4, and Cargo versions before 1.78 do not understand it. The format is checked before anything else, so even cargo update fails.",
        steps=("Use a Rust toolchain of 1.78 or later, or", "change version = 4 to version = 3 in Cargo.lock (or delete it and run cargo generate-lockfile with the older Cargo).", "Pin the toolchain in rust-toolchain.toml so every machine uses the same Cargo."),
        tags=("rust", "cargo", "cargo.lock", "toolchain"), message="lock file version",
    ),
    from_probe(
        "rust-msrv-dependency", category="dependency", error_type="rustc is not supported by the following package", runtime=RUST178, memory="2g",
        summary="A crate in the dependency tree needs a newer rustc than the installed one, and Cargo stops with a message listing the package and the version it requires.",
        context="Building a project on Rust 1.78 after cargo picked the newest releases of its dependencies.",
        failed_approaches=("cd /w && cargo build --release 2>&1", "cd /w && cargo build --offline 2>&1"),
        fix="cd /w && cargo add time@=0.3.36 && cargo update powerfmt --precise 0.2.0 && cargo build", verify="cd /w && cargo build && echo built",
        root_cause="Crates declare the oldest compiler they support (rust-version). Cargo resolves to the newest releases unless told otherwise, and a release can require a compiler newer than yours.",
        steps=("Update the toolchain: rustup update.", "Or select releases that support your compiler: cargo update <crate> --precise <version>, or pin the dependency.", "Set resolver.incompatible-rust-versions = \"fallback\" in .cargo/config.toml (Cargo 1.84 and later) so Cargo prefers compatible releases."),
        tags=("rust", "cargo", "msrv", "rust-version"), message="is not supported by the following package",
    ),
    from_probe(
        "rust-musl-target-missing", category="build", error_type="target may not be installed", runtime={"name": "rust", "version": "1.82"}, memory="2g",
        summary="Building for the musl target fails with a note that the target may not be installed, because rustup has not added its standard library.",
        context="Making a static Linux binary with cargo build --target x86_64-unknown-linux-musl.",
        failed_approaches=("cd /w && cargo build --target x86_64-unknown-linux-musl --release 2>&1", "cd /w && rustc --target x86_64-unknown-linux-musl src/main.rs 2>&1"),
        fix="rustup target add x86_64-unknown-linux-musl && cd /w && cargo build --target x86_64-unknown-linux-musl", verify="cd /w && ls target/x86_64-unknown-linux-musl/debug/w",
        root_cause="A rustup toolchain contains the standard library only for the host target. Every other target, such as musl or wasm32, has to be installed with rustup target add.",
        steps=("Run rustup target add x86_64-unknown-linux-musl.", "A crate with C dependencies also needs a musl C toolchain (musl-tools, or a cross tool).", "List the installed targets with rustup target list --installed."),
        tags=("rust", "musl", "rustup", "cross-compilation"), message="target may not be installed",
    ),
)

TASKS += (
    from_probe(
        "rust-feature-on-stable", category="build", error_type="E0554", runtime={"name": "rust", "version": "1.82"}, memory="2g",
        summary="rustc refuses #![feature(...)] on the stable channel with error E0554, because unstable language features exist only on nightly.",
        context="Building code or a dependency copied from a nightly-only project with a stable toolchain.",
        failed_approaches=("cd /w && cargo +nightly build 2>&1", "cd /w && cargo build --release 2>&1"),
        fix="""cd /w && printf 'fn main() {}\\n' > src/main.rs && cargo build""", verify="cd /w && cargo build && echo built",
        root_cause="Feature gates are only honoured by the nightly compiler (or with RUSTC_BOOTSTRAP, which is unsupported). Stable rejects the attribute outright, whichever feature it names.",
        steps=("Remove the feature gate and use the stabilised equivalent (many features have become stable: check the release notes of your Rust version).", "Or pin nightly for the project in rust-toolchain.toml and accept its instability.", "If the gate is in a dependency, upgrade it: most crates have dropped nightly requirements."),
        tags=("rust", "nightly", "feature-gate", "e0554"), message="may not be used on the stable release channel",
    ),
)

TASKS += (
    from_probe(
        "rust-offline-registry-empty", category="dependency", error_type="no matching package named", runtime={"name": "rust", "version": "1.82"}, memory="2g",
        summary="cargo build --offline fails with no matching package named serde found when the local registry cache is empty, as in a fresh CI runner or container.",
        context="Building offline, or with net.offline set, on a machine that never downloaded the crates the project depends on.",
        failed_approaches=("cd /w && cargo build --offline --locked 2>&1", "cd /w && cargo fetch --offline 2>&1"),
        fix="cd /w && cargo fetch && cargo build --offline", verify="cd /w && cargo build --offline 2>&1 | tail -n 2",
        root_cause="Offline mode resolves only from the local registry cache in CARGO_HOME. With nothing cached, no crate matches, and --locked or fetching offline cannot download what is missing.",
        steps=("Run cargo fetch once with network access, or restore the CARGO_HOME registry from a cache, before building offline.", "To build with no network at all, vendor the dependencies with cargo vendor and point cargo at the vendor directory."),
        tags=("rust", "cargo", "offline", "registry", "ci"), message="no matching package named",
    ),
    from_probe(
        "rust-linker-cc-not-found", category="build", error_type="linker not found", runtime={"name": "rust", "version": "stable"}, memory="2g",
        summary="cargo build fails with error: linker cc not found on a minimal Debian or Ubuntu image where Rust was installed but no C compiler or linker was.",
        context="Building a Rust project in a slim container after installing the toolchain with rustup.",
        failed_approaches=(". $HOME/.cargo/env && cd /w && cargo clean && cargo build 2>&1", """. $HOME/.cargo/env && cd /w && RUSTFLAGS="-C linker=gcc" cargo build 2>&1"""),
        fix=". $HOME/.cargo/env && apt-get install -y -qq build-essential >/dev/null && cd /w && cargo build", verify=". $HOME/.cargo/env && cd /w && cargo build 2>&1 | tail -n 2",
        root_cause="rustc compiles to object files but asks the system linker, by default cc, to produce the binary. A minimal image has no cc, and naming gcc as the linker fails the same way because gcc is not installed either.",
        steps=("Install a C toolchain: apt-get install build-essential on Debian and Ubuntu, or the equivalent package on other systems.", "In a Dockerfile, install it in the same layer as the other build packages, before cargo build."),
        tags=("rust", "linker", "docker", "debian"), message="linker `cc` not found",
    ),
)

TASKS += (
    from_probe(
        "rust-locked-lockfile-needs-update", category="build", error_type="the lock file needs to be updated but --locked was passed", runtime={"name": "rust", "version": "1.82"}, memory="2g",
        summary="cargo build --locked fails because the lock file needs to be updated but --locked was passed, when Cargo.lock is missing or does not match Cargo.toml.",
        context="A CI step or Docker build that runs cargo build --locked on a checkout where Cargo.lock was not committed, or was not updated after a dependency change.",
        failed_approaches=("cd /w && cargo build --locked --offline 2>&1", "cd /w && cargo update --locked 2>&1"),
        fix="cd /w && cargo generate-lockfile && cargo build --locked", verify="cd /w && cargo build --locked 2>&1 | tail -n 2",
        root_cause="--locked tells cargo to use Cargo.lock exactly as it is and fail when it would have to change it, which includes creating it. Without a committed, current lock file there is nothing to be exact about, and --offline or cargo update --locked cannot write one.",
        steps=("Generate and commit the lock file: cargo generate-lockfile (or any cargo build), then commit Cargo.lock; applications and binaries should always commit it.", "After editing Cargo.toml, run cargo update -w or cargo build without --locked once locally and commit the new Cargo.lock."),
        tags=("rust", "cargo", "lockfile", "ci", "locked"), message="needs to be updated but --locked was passed",
    ),
)
