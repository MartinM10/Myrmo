import sys

from . import __version__
from .config import ConfigError, load

USAGE = f"acmeframe {__version__}\nusage: python -m acmeframe {{run,check}} <service.toml>"

args = sys.argv[1:]
if len(args) != 2:
    sys.exit(USAGE)
command, path = args
if command == "migrate-config":
    from .migrate import migrate
    migrate(path)
    sys.exit(0)
if command not in ("run", "check"):
    sys.exit(USAGE)
try:
    data = load(path)
except ConfigError as error:
    print(f"acmeframe: ConfigError: {error}", file=sys.stderr)
    sys.exit(2)
if command == "check":
    print(f"config OK: {data['service']['name']} on port {data['server']['port']}")
else:
    print(f"{data['service']['name']} would serve on port {data['server']['port']}")
