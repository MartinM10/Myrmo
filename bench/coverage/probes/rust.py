from probe import P

PROBES = [
    P("rust-edition2024-old-cargo", "rust", "rust:1.78", "cargo new -q /w --bin && cd /w && sed -i 's/edition = \"2021\"/edition = \"2024\"/' Cargo.toml",
      "cargo build 2>&1", r"feature `edition2024` is required",
      {"cargo": "1.78", "edition": "2024"}, "https://raw.githubusercontent.com/rust-lang/cargo/master/doc/book/src/reference/unstable.md",
      "edition", "MIT OR Apache-2.0", must=(r"edition2024|edition = \"2024\"", r"cargo|rustc|rustup")),
    P("rust-msrv-dependency", "rust", "rust:1.78", "cargo new -q /w --bin && cd /w && cargo add time@=0.3.41 -q",
      "cargo build 2>&1", r"is not supported by the following package|cannot be built because it requires rustc",
      {"cargo": "1.78", "time": "0.3.41"}, "https://raw.githubusercontent.com/rust-lang/cargo/master/doc/book/src/reference/rust-version.md",
      "rust-version", "MIT OR Apache-2.0", must=(r"requires rustc|rust-version|MSRV", r"cargo|rustup|time")),
    P("rust-lockfile-v4-old-cargo", "rust", "rust:1.75", "cargo new -q /w --bin && cd /w && cargo generate-lockfile && sed -i 's/^version = 3/version = 4/' Cargo.lock",
      "cargo build 2>&1", r"lock file version",
      {"cargo": "1.75", "lockfile": "4"}, "https://raw.githubusercontent.com/rust-lang/cargo/master/crates/cargo-util-schemas/src/lockfile.rs",
      "lock", "MIT OR Apache-2.0", must=(r"lock ?file", r"version 4|v4|cargo")),
    P("rust-openssl-sys-no-pkgconfig", "rust", "rust:1.82-slim", "cargo new -q /w --bin && cd /w && cargo add openssl@0.10 -q",
      "cargo build 2>&1", r"Could not find openssl via pkg-config|The pkg-config command could not be found",
      {"cargo": "1.82", "openssl": "0.10", "os": "debian-slim"}, "https://raw.githubusercontent.com/sfackler/rust-openssl/master/openssl/src/lib.rs",
      "OPENSSL_DIR", "MIT OR Apache-2.0", must=(r"openssl", r"pkg-config|libssl-dev|OPENSSL_DIR")),
    P("rust-musl-target-missing", "rust", "rust:1.82", "cargo new -q /w --bin && cd /w",
      "cargo build --target x86_64-unknown-linux-musl 2>&1", r"target may not be installed",
      {"cargo": "1.82"}, "https://raw.githubusercontent.com/rust-lang/rustup/master/doc/user-guide/src/cross-compilation.md",
      "rustup target add", "MIT OR Apache-2.0", must=(r"musl", r"rustup target add")),
]
