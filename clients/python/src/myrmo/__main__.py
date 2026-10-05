"""`python -m myrmo config [publish auto|ask|off]`: show or change the user's settings."""

import sys

from .config import MODES, config_path, read_config, write_config


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] != ["config"]:
        print("Usage: python -m myrmo config [publish auto|ask|off]", file=sys.stderr)
        return 2
    if args[1:2] == ["publish"]:
        if args[2:3] == [] or args[2] not in MODES:
            print("Usage: python -m myrmo config publish auto|ask|off", file=sys.stderr)
            return 2
        write_config(publish=args[2])
        print(f"Saved to {config_path()}: agents publish with publish={args[2]}.")
        return 0
    print(f"Settings file: {config_path()}")
    print(f"publish: {read_config().get('publish') or '(not chosen yet: agents publish nothing)'}")
    print(f"agent id: {read_config().get('agent_id') or '(created on first use)'}   (a random pseudonym; delete it from the file to get a new one, MYRMO_ANONYMOUS=1 sends none)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
