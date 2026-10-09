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

TASKS += (
    from_probe(
        "platform-pip-alpine-gcc-missing", category="platform", error_type="No such file or directory: 'gcc'", runtime={"name": "python", "version": "3.12"}, memory="2g",
        summary="pip install fails on an Alpine image with error: [Errno 2] No such file or directory: 'gcc' while building a wheel for a package that has no musl wheel for this Python.",
        context="Installing a pinned, older release of a package with a C extension in python:3.12-alpine or another musl image, where pip has to compile it.",
        failed_approaches=("pip install --upgrade pip setuptools wheel >/dev/null 2>&1; pip install bitarray==2.0.0 2>&1", "pip install --no-build-isolation bitarray==2.0.0 2>&1"),
        fix="pip install bitarray", verify="""python -c "import bitarray; print(bitarray.__version__)" """,
        root_cause="pip uses a prebuilt wheel when the package publishes one for this platform and Python. Alpine uses musl, so only musllinux wheels fit, and an old pinned release has none for Python 3.12: pip then builds from source, which needs a C compiler that the Alpine Python image does not include. Upgrading pip does not add one.",
        steps=("Prefer a release that publishes a musllinux wheel for your Python (often the latest): drop or raise the pin.", "Or install the build tools in the image (apk add --no-cache build-base, and the library headers the package needs) before pip install, or use a Debian-based slim image where manylinux wheels apply."),
        tags=("pip", "alpine", "musl", "wheel", "docker", "gcc"), message="No such file or directory: 'gcc'",
    ),
)
