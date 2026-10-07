"""A haystack of varied trails, for testing a colony at scale.

    python bench/scale/populate.py http://localhost:8080 1000000

`bench/load/populate.py` makes variants of the nine seed trails, which tests throughput but not search: a million
near copies of nine errors say nothing about finding one trail among many. This makes trails that differ the way
real ones do: the same kind of error (a missing module, a refused connection, a failed build) about thousands of
different modules, packages, classes, hosts, tables and crates, in many ecosystems. Each trail is a pure function of
its number and the seed, so a test can regenerate trail 731,204 without a ledger and ask whether it can be found.

The names are made-up pronounceable words (`kodavuri`), so no trail is about a real project, and two trails of the
same kind differ in one identifier, which is the hard case for search: `No module named 'kodavuri'` against
`No module named 'kodavuro'`.
"""

from __future__ import annotations

import random
from typing import Callable

CONSONANTS = "bdfgklmnprstvz"
VOWELS = "aeiou"


def word(rnd: random.Random, syllables: int = 4) -> str:
    return "".join(rnd.choice(CONSONANTS) + rnd.choice(VOWELS) for _ in range(syllables))


def camel(rnd: random.Random) -> str:
    return word(rnd, 2).capitalize() + word(rnd, 2).capitalize()


def hostname(rnd: random.Random) -> str:
    return f"{word(rnd, 2)}-{rnd.randint(1, 40)}.{word(rnd, 2)}.example.test"


def path(rnd: random.Random) -> str:
    return "/" + "/".join(word(rnd, 2) for _ in range(rnd.randint(2, 4))) + rnd.choice([".yaml", ".json", ".conf", ".txt", ""])


def version(rnd: random.Random) -> str:
    return f"{rnd.randint(0, 9)}.{rnd.randint(0, 30)}.{rnd.randint(0, 20)}"


# Each family: (runtime, ecosystem category, error_type, message, root cause, fix command). `{x}` fields are filled
# from the generators below, one fresh value per use.
Family = tuple[str, str, str, str, str, str]

FAMILIES: list[Family] = [
    ("python", "dependency", "ModuleNotFoundError", "ModuleNotFoundError: No module named '{w}'", "The package that provides the module {w} is not installed in this environment.", "pip install {w}"),
    ("python", "dependency", "ImportError", "ImportError: cannot import name '{c}' from '{w}' (/usr/lib/python3/site-packages/{w}/__init__.py)", "The installed version of {w} predates the name {c}, which was added in a later release.", "pip install --upgrade {w}"),
    ("python", "dependency", "AttributeError", "AttributeError: module '{w}' has no attribute '{w2}'", "{w} removed the attribute {w2} in a newer major version that this project does not support yet.", "pip install '{w}<{v}'"),
    ("python", "configuration", "KeyError", "KeyError: '{ENV}'", "The environment variable {ENV} is read at import time and is not set in this shell.", "export {ENV}=value"),
    ("python", "configuration", "FileNotFoundError", "FileNotFoundError: [Errno 2] No such file or directory: '{w}.yaml'", "The service resolves {w}.yaml from the working directory, which differs under the process manager.", "cd /srv/{w} && python app.py"),
    ("python", "network", "OperationalError", "psycopg2.OperationalError: connection to server at \"{h}\", port 5432 failed: FATAL:  password authentication failed for user \"{w}\"", "The role {w} was created with scram-sha-256 and the client library is linked against an older libpq.", "pip install --upgrade psycopg2-binary"),
    ("python", "dependency", "No matching distribution found", "ERROR: No matching distribution found for {w}=={v}", "The release {v} of {w} was yanked from the index and the pin still asks for it.", "pip install '{w}>={v}'"),
    ("node", "dependency", "MODULE_NOT_FOUND", "Error: Cannot find module '{w}'\nRequire stack:\n- {p}", "The dependency {w} is listed in devDependencies and the production install skipped it.", "npm install --save {w}"),
    ("node", "dependency", "E404", "npm error code E404\nnpm error 404 '{w}@{v}' is not in this registry.", "The package name {w} is private to another registry, which is not configured for this scope.", "npm config set registry https://registry.example.test/"),
    ("node", "network", "EADDRINUSE", "Error: listen EADDRINUSE: address already in use :::{n}\n    at {w}.listen (/app/server.js:12:5)", "A previous process of {w} still holds port {n} because it ignores SIGTERM.", "kill -9 $(lsof -ti :{n})"),
    ("node", "runtime", "TypeError", "TypeError: Cannot read properties of undefined (reading '{w}')", "The response of the {w} service changed shape and the field is absent for new accounts.", "git apply fix-{w}.patch"),
    ("node", "dependency", "ERR_PACKAGE_PATH_NOT_EXPORTED", "Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath '{w}' is not defined by \"exports\" of package {w2}", "The package {w2} added an exports map that does not list the deep import {w}.", "npm install {w2}@{v}"),
    ("java", "build", "ClassNotFoundException", "java.lang.ClassNotFoundException: com.{w}.{C}", "The jar that holds com.{w}.{C} is not on the runtime classpath of the shaded artifact.", "mvn dependency:copy-dependencies"),
    ("java", "runtime", "NoSuchMethodError", "java.lang.NoSuchMethodError: 'void com.{w}.{C}.{w2}(java.lang.String)'", "Two versions of com.{w} are on the classpath and the older one wins.", "mvn dependency:tree -Dincludes=com.{w}"),
    ("java", "build", "UnsupportedClassVersionError", "java.lang.UnsupportedClassVersionError: com.{w}.{C} has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0", "The library was built for Java 21 and the service still runs on Java 17.", "sdk use java 21.0.2-tem"),
    ("jvm", "build", "CompilationError", "[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.11.0:compile (default-compile) on project {w}: Compilation failure: package com.{w2} does not exist", "The module {w} depends on com.{w2} only transitively and the dependency was excluded.", "mvn -pl {w} -am install"),
    ("rust", "build", "E0432", "error[E0432]: unresolved import `{w}::{w2}`", "The crate {w} moved {w2} behind a feature flag that is not enabled.", "cargo add {w} --features {w2}"),
    ("rust", "build", "linker", "error: linking with `cc` failed: exit status: 1\n  = note: /usr/bin/ld: cannot find -l{w}", "The system library {w} is not installed in the build image.", "apt-get install -y lib{w}-dev"),
    ("go", "dependency", "no required module provides package", "main.go:4:2: no required module provides package {w}.example.test; to add it:\n\tgo get {w}.example.test", "The import is not listed in go.mod because the vendor directory is out of date.", "go get {w}.example.test@latest"),
    ("docker", "platform", "pull access denied", "Error response from daemon: pull access denied for {w}, repository does not exist or may require 'docker login'", "The image {w} lives in a private registry and the daemon is not logged in.", "docker login registry.example.test"),
    ("docker", "platform", "Conflict", "docker: Error response from daemon: Conflict. The container name \"{w}\" is already in use by container \"{x}\".", "A stopped container still owns the name {w}.", "docker rm -f {w}"),
    ("kubernetes", "platform", "NotFound", "Error from server (NotFound): pods \"{w}-{x}\" not found", "The pod was rescheduled with a new suffix and the script holds the old name.", "kubectl get pods -l app={w}"),
    ("kubernetes", "platform", "CrashLoopBackOff", "Back-off restarting failed container {w} in pod {w2}-{x}_prod({x2})", "The container exits because the config map {w} is mounted read-only and the entrypoint writes to it.", "kubectl rollout restart deployment/{w2}"),
    ("terraform", "configuration", "provider", "Error: Failed to query available provider packages: could not retrieve the list of available versions for provider {w}: no available releases match the given constraints {v}", "The provider constraint is older than any release for this platform.", "terraform init -upgrade"),
    ("git", "network", "SSL certificate problem", "fatal: unable to access the repository {w}: SSL certificate problem: unable to get local issuer certificate", "The internal git host of {w} uses a certificate from a CA that the container does not trust.", "git config --global http.sslCAInfo /etc/ssl/certs/ca.pem"),
    ("ssh", "network", "Could not resolve hostname", "ssh: Could not resolve hostname {h}: Name or service not known", "The host name only resolves through the VPN resolver, which is not in use.", "resolvectl dns tun0 10.0.0.2"),
    ("systemd", "configuration", "Unit not found", "Failed to start {w}.service: Unit {w}.service not found.", "The unit file was installed under /usr/local/lib/systemd and the daemon was not reloaded.", "systemctl daemon-reload"),
    ("postgresql", "configuration", "relation does not exist", "ERROR:  relation \"{w}_{w2}\" does not exist\nLINE 1: SELECT * FROM {w}_{w2}", "The migration that creates the table ran against another schema.", "psql -c 'SET search_path TO {w}, public'"),
    ("mysql", "configuration", "Access denied", "ERROR 1045 (28000): Access denied for user '{w}'@'{h}' (using password: YES)", "The account was created for localhost only and the client connects over the network.", "CREATE USER '{w}'@'%' IDENTIFIED BY '...'"),
    ("gcc", "build", "fatal error", "fatal error: {w}/{w2}.h: No such file or directory\n    4 | #include <{w}/{w2}.h>", "The development package for {w} is not installed.", "apt-get install -y lib{w}-dev"),
    ("cmake", "build", "CMake Error", "CMake Error at CMakeLists.txt:12 (find_package): Could not find a package configuration file provided by \"{C}\" with any of the following names: {C}Config.cmake", "The package {C} is installed outside the default prefixes.", "cmake -DCMAKE_PREFIX_PATH=/opt/{w} .."),
    ("make", "build", "No rule to make target", "make: *** No rule to make target '{w}/{w2}.o', needed by '{w}'.  Stop.", "A generated source list is stale after a branch switch.", "make clean && make"),
    ("dotnet", "dependency", "NU1101", "error NU1101: Unable to find package {C}. No packages exist with this id in source(s): nuget.org", "The package {C} is hosted on a private feed that is missing from NuGet.config.", "dotnet nuget add source https://nuget.example.test/v3/index.json"),
    ("dotnet", "build", "CS0246", "error CS0246: The type or namespace name '{C}' could not be found (are you missing a using directive or an assembly reference?)", "The project references {C} through a package that targets a newer framework.", "dotnet add package {C}"),
]


# The errors whose identifying name is a path, a URL or a number, which the fingerprint replaces by a placeholder
# (`<path>`, `<url>`, `<n>`): every package of the family gets the same key. Real trails do this all the time (a Go
# module path, a Docker image, a git URL, a registry URL), so they are kept apart, to be measured on purpose.
COLLAPSING: list[Family] = [
    ("go", "dependency", "no required module provides package", "main.go:4:2: no required module provides package github.com/{w}/{w2}; to add it:\n\tgo get github.com/{w}/{w2}", "The import is not listed in go.mod because the vendor directory is out of date.", "go get github.com/{w}/{w2}@latest"),
    ("docker", "platform", "pull access denied", "Error response from daemon: pull access denied for {w}/{w2}, repository does not exist or may require 'docker login'", "The image {w}/{w2} lives in a private registry and the daemon is not logged in.", "docker login registry.{w}.example.test"),
    ("git", "network", "unable to access", "fatal: unable to access 'https://git.{h}/{w}/{w2}.git/': SSL certificate problem: unable to get local issuer certificate", "The internal git host uses a certificate from a CA that the container does not trust.", "git config --global http.sslCAInfo /etc/ssl/certs/{w}.pem"),
    ("node", "dependency", "E404", "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/{w} - Not found", "The package name {w} is private to another registry, which is not configured for this scope.", "npm config set @{w}:registry https://registry.example.test/"),
    ("python", "configuration", "FileNotFoundError", "FileNotFoundError: [Errno 2] No such file or directory: '{p}'", "The service resolves the path {p} from the working directory, which differs under the process manager.", "cd /srv/{w} && python app.py"),
]


def fill(template: str, rnd: random.Random) -> str:
    """Replace each `{key}` with a fresh value, so two fields of one trail differ."""
    makers: dict[str, Callable[[], str]] = {
        "w": lambda: word(rnd), "w2": lambda: word(rnd, 3), "c": lambda: camel(rnd), "C": lambda: camel(rnd),
        "p": lambda: path(rnd), "h": lambda: hostname(rnd), "v": lambda: version(rnd), "n": lambda: str(rnd.randint(1024, 65000)),
        "x": lambda: format(rnd.getrandbits(48), "012x"), "x2": lambda: format(rnd.getrandbits(48), "012x"),
        "ENV": lambda: (word(rnd, 2) + "_" + word(rnd, 2)).upper(),
    }
    values: dict[str, str] = {}
    out = []
    i = 0
    while i < len(template):
        if template[i] == "{":
            j = template.index("}", i)
            key = template[i + 1 : j]
            if key not in values:
                values[key] = makers[key]()
            out.append(values[key])
            i = j + 1
        else:
            out.append(template[i])
            i += 1
    return "".join(out)


def make_trail(i: int, seed: int = 11, collapsing: bool = False) -> dict:
    """Trail number `i`: a pure function of `i` and `seed`. With `collapsing`, from the families whose names the
    fingerprint replaces by a placeholder, so that many trails share one key."""
    rnd = random.Random(f"{seed}:{i}")
    families = COLLAPSING if collapsing else FAMILIES
    runtime, category, error_type, message, cause, fix = families[rnd.randrange(len(families))]
    # One set of names per trail, shared by every field that mentions them.
    names = random.Random(f"{seed}:{i}:names")
    template = "\x00".join([message, cause, fix])
    filled = fill(template, names).split("\x00")
    message, cause, fix = filled
    first_line = message.splitlines()[0]
    return {
        "protocol_version": "1.0",
        "agent_info": {"model": "synthetic", "framework": "myrmo-bench"},
        "environment": {
            "os": "linux",
            "os_version": rnd.choice(["ubuntu-22.04", "ubuntu-24.04", "debian-12", "alpine-3.20"]),
            "arch": rnd.choice(["x86_64", "arm64"]),
            "container": rnd.choice(["docker", "none"]),
            "runtime": {"name": runtime, "version": version(rnd)},
            "packages": [],
        },
        "problem": {
            "error_type": error_type,
            "error_message": message,
            "summary": f"{runtime} fails with: {first_line}"[:300],
            "task_context": f"Running a {category} step of a {runtime} project.",
            "raw_logs": message,
            "category": category,
            "failed_approaches": [{"approach": "Retried the command a second time.", "why_it_failed": first_line[:200]}],
        },
        "solution": {
            "root_cause": cause,
            "steps": [f"Run: {fix}", "Run the failing command again."],
            "shell_commands_executed": [{"command": fix, "purpose": "Apply the fix."}],
            "code_patches": [],
            "verification_method": {"type": "command_exit_zero", "description": "The command that failed now exits with code zero.", "command": "true", "evidence": "exit code 0"},
        },
        "effort": {"failed_attempts": 1, "wall_time_seconds": 30},
        "tags": ["synthetic", "bench", "scale", "collapsing" if collapsing else "unique"],
    }
