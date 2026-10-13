"""Python packaging and tooling breakages that are environment, version or configuration problems.

Every task runs offline in python:3.12-slim (no network): packages are hand-built wheels written by the setup
into /w/dist or /w/built, so the commands reproduce without an index. Fixes change tooling, configuration or
which dependency is installed; none of them edits application code.
"""

from .base import Task

PY312 = {"name": "python", "version": "3.12"}

# Writes wheels by hand (a wheel is a zip with METADATA, WHEEL and RECORD), so no build backend is needed.
_HELPER = r'''
import os, zipfile
def wheel(out, name, version, body, tag="py3-none-any", requires_python=None, requires=()):
    os.makedirs(out, exist_ok=True)
    mod = name.replace("-", "_")
    dist = f"{mod}-{version}.dist-info"
    meta = f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n"
    if requires_python:
        meta += f"Requires-Python: {requires_python}\n"
    for item in requires:
        meta += f"Requires-Dist: {item}\n"
    info = f"Wheel-Version: 1.0\nGenerator: handmade\nRoot-Is-Purelib: true\nTag: {tag}\n"
    with zipfile.ZipFile(os.path.join(out, f"{mod}-{version}-{tag}.whl"), "w") as z:
        z.writestr(f"{mod}.py", body + "\n")
        z.writestr(f"{dist}/METADATA", meta)
        z.writestr(f"{dist}/WHEEL", info)
        z.writestr(f"{dist}/RECORD", "")
'''


def _wheels(*calls: str) -> str:
    """A shell heredoc that runs the wheel helper and then the given calls."""
    return "python - <<'PYEOF'\n" + _HELPER + "\n".join(calls) + "\nPYEOF\n"


TASKS = (
    Task(
        "py-pip-check-broken-requirement", "python:3.12-slim", PY312, "dependency", "has requirement",
        "pip check reports that app 1.0 needs lib<2 while lib 2.0 is installed, so the environment has a broken dependency set.",
        "Installing an application offline, then forcing a newer library into the same environment by hand.",
        _wheels(
            'wheel("/w/dist", "lib", "1.0", "VALUE = 1")',
            'wheel("/w/dist", "lib", "2.0", "VALUE = 2")',
            'wheel("/w/dist", "app", "1.0", "APP = 1", requires=("lib<2",))',
        ) + "pip install -q --no-index --find-links /w/dist app && pip install -q --no-index --no-deps --find-links /w/dist lib==2.0\n",
        "pip check",
        ('pip install -q --no-index --find-links /w/dist "app==1.0" "lib==2.0"', 'pip install -q --no-index --find-links /w/dist "lib==3.0"'),
        'pip install -q --no-index --find-links /w/dist "lib<2"',
        "pip check",
        "pip check compares every installed requirement with the installed versions. The forced install of lib 2.0 broke app's pin, and pip's resolver refuses the same pair when asked to install them together. Downgrading the library to the range the dependent package declares restores a consistent set.",
        ("Find the requirement that pip check names (here app 1.0 requires lib<2).", "Install the library version inside the declared range, offline from the local wheelhouse.", "Run pip check again and expect No broken requirements found."),
        ("python", "pip", "pip-check", "dependency-conflict", "offline"),
        ecosystem="python", written_by_model="claude-haiku-5-5",
    ),
    Task(
        "py-pip-wheel-cp311-on-312", "python:3.12-slim", PY312, "dependency", "is not a supported wheel",
        "pip refuses a wheel built for CPython 3.11 on a Python 3.12 interpreter with 'is not a supported wheel on this platform'.",
        "Installing a wheel that a build machine produced for another interpreter version, copied into a 3.12 image.",
        _wheels(
            'wheel("/w/built", "fastlib", "1.0", "FAST = 1", tag="cp311-cp311-linux_x86_64")',
            'wheel("/w/dist", "fastlib", "1.0", "FAST = 1")',
        ),
        "pip install --no-index /w/built/fastlib-1.0-cp311-cp311-linux_x86_64.whl",
        ("pip install --no-index --find-links /w/built fastlib==1.0", "pip install --no-index --find-links /w/built --no-binary=:all: fastlib==1.0"),
        "pip install -q --no-index /w/dist/fastlib-1.0-py3-none-any.whl",
        'python -c "import fastlib; print(fastlib.FAST)"',
        "The wheel filename carries compatibility tags (cp311 means CPython 3.11 only). pip checks them against the running interpreter before it reads the file, so a cp311 wheel is never installable on 3.12. A pure-Python build (py3-none-any) works on every interpreter.",
        ("Read the tags at the end of the wheel filename: cp311-cp311 is CPython 3.11 only.", "Install the wheel built for this interpreter, or a pure-Python py3-none-any wheel.", "Rebuild the wheel on the target interpreter if no compatible file exists."),
        ("python", "pip", "wheel", "platform-tag", "offline"),
        ecosystem="python", written_by_model="claude-haiku-5-5",
    ),
    Task(
        "py-pip-newest-release-requires-python", "python:3.12-slim", PY312, "dependency", "requires a different Python",
        "pip refuses the newest newpkg release because it declares Requires-Python >=3.13, while the image runs Python 3.12.",
        "Installing a pinned release from a local wheelhouse on a Python 3.12 image.",
        _wheels(
            'wheel("/w/dist", "newpkg", "1.0", "VALUE = 1", requires_python=">=3.8")',
            'wheel("/w/dist", "newpkg", "2.0", "VALUE = 2", requires_python=">=3.13")',
        ),
        "pip install --no-index --find-links /w/dist newpkg==2.0",
        ('pip install --no-index --find-links /w/dist "newpkg>=3"', "pip install --no-index --no-deps /w/dist/newpkg-2.0-py3-none-any.whl"),
        "pip install -q --no-index --find-links /w/dist newpkg",
        'python -c "import newpkg; print(newpkg.VALUE)"',
        "Requires-Python is metadata that pip compares with the running interpreter before it considers a release. A release that needs a newer Python is not a candidate, so pip installs the newest release that does support this interpreter, or stops when the pin points only at the unsupported one.",
        ("Read the Requires-Python range pip reports for the pinned release.", "Either use an interpreter inside that range (a newer base image), or install the newest release whose range includes the running Python.", "Use --ignore-requires-python only to test, because it can install code that fails at import time."),
        ("python", "pip", "requires-python", "version", "offline"),
        ecosystem="python", written_by_model="claude-haiku-5-5",
    ),
    Task(
        "py-pythonpath-shadows-stdlib-json", "python:3.12-slim", PY312, "configuration", "AttributeError",
        "A stray json.py on PYTHONPATH replaces the standard library json module, so json.dumps fails with has no attribute 'dumps'.",
        "Running a small script with PYTHONPATH pointing at a folder that holds a hand-copied helper named json.py.",
        'mkdir -p /w/lib\ncat > /w/lib/json.py <<\'EOF\'\n# a helper, copied here by hand\nVALUE = 1\nEOF\ncat > /w/app.py <<\'EOF\'\nimport json\nprint(json.dumps({"ok": True}))\nEOF\n',
        "cd /w && PYTHONPATH=/w/lib python app.py",
        ('cd /w && PYTHONPATH=/w/lib python -c "import json; json.loads(\'1\')"', "cd /w && PYTHONPATH=/w/lib python -m json.tool /w/app.py"),
        "cd /w && PYTHONPATH= python app.py",
        'cd /w && PYTHONPATH= python -c "import json; print(json.__file__)" && PYTHONPATH= python app.py',
        "PYTHONPATH entries are searched before the standard library. Any file on that path named like a stdlib module (json.py, email.py, logging.py) replaces the real module for every import in the process, including the ones made by the interpreter's own tools. The fix is to keep the helper directory off the path that the program uses, not to edit the program.",
        ("Print json.__file__ with the same PYTHONPATH to see which file is loaded.", "Remove the directory that holds the shadowing file from PYTHONPATH, or rename the file.", "Run the program again without the shadowing entry."),
        ("python", "pythonpath", "stdlib", "shadowing", "configuration"),
        ecosystem="python", written_by_model="claude-haiku-5-5",
    ),
    Task(
        "py-unittest-discover-not-package", "python:3.12-slim", PY312, "tooling", "ImportError",
        "unittest discover stops with Start directory is not importable because the tests folder has no __init__.py when a top-level directory is given.",
        "Running the test suite with python -m unittest discover -t . from a project whose tests folder was created without a package marker.",
        'mkdir -p /w/tests\ncat > /w/tests/test_ok.py <<\'EOF\'\nimport unittest\n\n\nclass OkTest(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\nEOF\n',
        "cd /w && python -m unittest discover -s tests -t .",
        ("cd /w && python -m unittest discover -s tests -t . -p \"test_*.py\"", "cd /w && python -m unittest discover -s tests/test_ok.py -t tests"),
        "cd /w && touch tests/__init__.py && python -m unittest discover -s tests -t .",
        "cd /w && python -m unittest discover -s tests -t . && test -f tests/__init__.py",
        "With -t (the top-level directory), unittest imports the start directory as a package, so it has to be importable: it needs an __init__.py. A plain folder of test files works only without -t, which resolves them from the current directory instead.",
        ("Add an empty __init__.py to the tests folder.", "Run discover with the same -s and -t arguments.", "Keep the test files named test*.py so discovery finds them."),
        ("python", "unittest", "packaging", "init-py"),
        ecosystem="python", written_by_model="claude-haiku-5-5",
    ),
    Task(
        "py-venv-without-pip-command", "python:3.12-slim", PY312, "tooling", "No module named pip",
        "A virtual environment created with --without-pip has no pip module, so running python -m pip inside it fails with No module named pip.",
        "Creating a venv in a minimal image with --without-pip and then calling its pip command directly.",
        "mkdir -p /w",
        "cd /w && python -m venv --without-pip /w/venv && /w/venv/bin/python -m pip --version",
        ("cd /w && python -m venv --without-pip /w/venv && /w/venv/bin/pip --version", "cd /w && python -m venv --without-pip /w/venv && /w/venv/bin/pip3 --version"),
        "cd /w && python -m venv --without-pip /w/venv && /w/venv/bin/python -m ensurepip --default-pip",
        "/w/venv/bin/pip --version",
        "--without-pip skips the bootstrap step that installs pip into the new environment, so the bin folder has the interpreter but no pip script. ensurepip installs the bundled pip; --default-pip also creates the plain pip command (without it only pip3 and pip3.12 are made).",
        ("Check the bin folder of the venv: python exists, pip does not.", "Bootstrap pip with python -m ensurepip --default-pip inside the venv.", "Or recreate the venv without --without-pip."),
        ("python", "venv", "pip", "ensurepip"),
        ecosystem="python", written_by_model="claude-haiku-5-5",
    ),
    Task(
        "py-pip-index-url-wheelhouse-folder", "python:3.12-slim", PY312, "dependency", "No matching distribution found",
        "pip install --index-url pointed at a folder of wheels finds no versions, because --index-url expects a PEP 503 index, not a directory of files.",
        "Trying to install a library from a local wheelhouse by passing its folder to --index-url.",
        _wheels('wheel("/w/dist", "lib", "1.0", "VALUE = 1")'),
        "pip install --index-url /w/dist lib",
        ("pip install --index-url file:///w/nothere lib", "pip install --no-index --index-url /w/dist lib"),
        "pip install -q --no-index --find-links /w/dist lib",
        'python -c "import lib; print(lib.VALUE)"',
        "--index-url replaces PyPI with a server that serves the simple index (a page per project). A plain folder of wheels is not an index, so pip sees no versions. A folder of wheels is read with --find-links, and --no-index keeps pip from contacting any index.",
        ("Use --find-links for a directory of wheels or sdists.", "Add --no-index so pip never contacts an index.", "Keep --index-url only for a real index URL."),
        ("python", "pip", "index-url", "find-links", "offline"),
        ecosystem="python", written_by_model="claude-haiku-5-5",
    ),
    Task(
        "py-venv-moved-stale-shebang", "python:3.12-slim", PY312, "tooling", "not found",
        "After a virtual environment folder is renamed, its pip script still points at the old interpreter path, so running it fails with not found.",
        "Moving a venv to a new folder name in a container and then running the pip command inside it.",
        "mkdir -p /w && cd /w && python -m venv /w/venv-src && mv /w/venv-src /w/venv-moved",
        "/w/venv-moved/bin/pip --version",
        ("/w/venv-moved/bin/pip3 --version", "cd /w/venv-moved/bin && ./pip --version"),
        "rm -rf /w/venv-moved && python -m venv /w/venv-moved",
        "/w/venv-moved/bin/pip --version",
        "The entry-point scripts of a venv (pip, pip3) begin with a shebang line that holds the absolute path of the interpreter the venv was created with. Moving the folder leaves that path dangling, and the kernel or shell cannot run the script. Venvs are not relocatable, so they must be recreated where they live.",
        ("Check the first line of the pip script: it names the old path.", "Recreate the venv at its final location.", "Do not copy venvs between machines or folders; create them where they are used."),
        ("python", "venv", "shebang", "relocation"),
        ecosystem="python", written_by_model="claude-haiku-5-5",
    ),
    Task(
        "py-pip-require-virtualenv-env", "python:3.12-slim", PY312, "configuration", "activated virtualenv",
        "pip refuses an install with 'Could not find an activated virtualenv (required)' when PIP_REQUIRE_VIRTUALENV is set and no virtual environment is active.",
        "A CI image sets pip to require a virtual environment, and a step installs a library into the system interpreter.",
        _wheels('wheel("/w/dist", "lib", "1.0", "VALUE = 1")'),
        "PIP_REQUIRE_VIRTUALENV=true pip install --no-index --find-links /w/dist lib",
        ("pip install --require-virtualenv --no-index --find-links /w/dist lib", "PIP_REQUIRE_VIRTUALENV=1 python -m pip install --no-index --find-links /w/dist lib"),
        "python -m venv /w/venv && /w/venv/bin/pip install -q --no-index --find-links /w/dist lib",
        '/w/venv/bin/python -c "import lib; print(lib.VALUE)"',
        "The setting makes pip refuse every install that would go into a system interpreter. The check is working as configured: it protects the system packages. The installation belongs in a virtual environment, and the requirement should stay in place.",
        ("Create a virtual environment for the project and install into it.", "Run that environment's pip, not the system one.", "Do not switch the requirement off in CI to make the step pass."),
        ("python", "pip", "virtualenv", "ci", "configuration"),
        ecosystem="python", written_by_model="claude-haiku-5-5",
    ),
    Task(
        "py-python-m-package-without-main", "python:3.12-slim", PY312, "tooling", "is a package and cannot be directly executed",
        "python -m app stops because app is a package with no __main__.py, so Python says it cannot be executed directly.",
        "Running a command-line package by its package name with python -m, when its entry point is a submodule.",
        "mkdir -p /w/app\ncat > /w/app/__init__.py <<'EOF'\nEOF\ncat > /w/app/cli.py <<'EOF'\nprint('cli ok')\nEOF\n",
        "cd /w && python -m app",
        ("cd /w && python -m app.cli.main", "cd /w && python -m app.main"),
        "cd /w && python -m app.cli",
        "cd /w && python -m app.cli && test -f app/__init__.py",
        "python -m <name> runs the module <name>, and for a package that means its __main__ submodule. A package without __main__.py cannot be run that way. The module that holds the entry point has to be named explicitly with a dotted path.",
        ("Name the module that holds the entry point: python -m app.cli.", "Or add a __main__.py that calls it, if the package should be runnable by name.", "Check the package's documented entry point before guessing."),
        ("python", "python-m", "packaging", "entry-point"),
        ecosystem="python", written_by_model="claude-haiku-5-5",
    ),
)
