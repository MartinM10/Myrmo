"""`python -m myrmo config [<setting> <value>]`: show or change the user's settings."""

import sys

from .config import config_path, read_config, set_setting, settings_report


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] != ["config"] or len(args) == 2 or len(args) > 3:
        print("Usage: python -m myrmo config [<setting> <value>]", file=sys.stderr)
        return 2
    if len(args) == 3:
        ok, message = set_setting(args[1], args[2])
        print(message, file=sys.stdout if ok else sys.stderr)
        return 0 if ok else 2
    print(f"Settings file: {config_path()}   (nothing here is required: every setting has a default)")
    for row in settings_report():
        print(f"  {row['key']:<20} {row['value']:<7} ({row['source']}) {row['about']}  [{row['values']}]")
    print(f"  {'agent id':<20} {read_config().get('agent_id') or '(created on first use)'}   a random pseudonym; delete it from the file for a new one")
    print("\nChange one with: python -m myrmo config <setting> <value>      (<value> = reset restores the default)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
