from probe import P

NODE_TGZ = "https://nodejs.org/dist/v18.20.4/node-v18.20.4-linux-x64.tar.gz"

PROBES = [
    P("platform-node18-glibc-too-old", "platform", "amazonlinux:2", f"yum install -y -q tar gzip >/dev/null && curl -fsSL {NODE_TGZ} | tar -xz -C /opt",
      "/opt/node-v18.20.4-linux-x64/bin/node -v 2>&1", r"GLIBC_2\.\d+. not found",
      {"node": "18.20.4", "glibc": "2.26", "os": "amazonlinux:2"}, "https://raw.githubusercontent.com/nodejs/node/v18.20.4/BUILDING.md",
      "glibc", "MIT", must=(r"GLIBC_\d|glibc.{0,40}(too old|older|newer)|older glibc", r"node")),
    P("platform-node-glibc-binary-on-alpine", "platform", "alpine:3.20", f"apk add -q curl >/dev/null && curl -fsSL {NODE_TGZ} | tar -xz -C /opt",
      "/opt/node-v18.20.4-linux-x64/bin/node -v 2>&1", r"not found",
      {"node": "18.20.4", "os": "alpine:3.20", "libc": "musl"}, "https://raw.githubusercontent.com/nodejs/node/v18.20.4/BUILDING.md",
      "musl", "MIT", must=(r"musl|gcompat|libstdc\+\+|alpine", r"node")),
]
