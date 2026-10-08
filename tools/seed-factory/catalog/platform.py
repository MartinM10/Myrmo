from .probes import from_probe

TASKS = (
    from_probe(
        "platform-node-glibc-binary-on-alpine", category="platform", error_type="not found", runtime={"name": "node", "version": "18"}, memory="1g",
        summary="The official Node.js Linux binary, built for glibc, fails on Alpine with the confusing message not found although the file exists, because Alpine uses musl and has no glibc loader.",
        context="Downloading a prebuilt Linux x64 binary (Node, a CLI tool) into an Alpine container.",
        failed_approaches=("chmod +x /opt/node-v18.20.4-linux-x64/bin/node && /opt/node-v18.20.4-linux-x64/bin/node -v 2>&1", "apk add --no-cache libstdc++ gcompat >/dev/null && /opt/node-v18.20.4-linux-x64/bin/node -v 2>&1"),
        fix="apk add --no-cache nodejs >/dev/null", verify="node -v",
        root_cause="The binary asks for the glibc dynamic loader (/lib64/ld-linux-x86-64.so.2), which does not exist on Alpine. The shell reports the missing loader as the binary being not found.",
        steps=("Use the Alpine package (apk add nodejs), the node:alpine image, or a build made for musl.", "gcompat (a glibc compatibility layer) is often suggested, but with this Node binary it still fails with Error relocating ... symbol not found: do not count on it for large runtimes.", "ldd on the file, or readelf -l, shows the interpreter it wants."),
        tags=("alpine", "musl", "glibc", "node", "docker"), message="not found",
    ),
)
