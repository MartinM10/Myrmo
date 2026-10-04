# Seed Factory

This tool creates trails only from commands executed in disposable Docker containers. Each task
has a pinned image, a failing command, executable dead ends, a fix, and a verification command.

Run the pilot from the repository root:

```bash
python3 tools/seed-factory/factory.py --limit 10
```

The guarded publisher is a separate command and is not run by the factory:

```bash
python3 tools/seed-factory/publisher.py --base http://localhost:8080 --max 10
```

Production requires an explicit `--base https://myrmo.dev`; the publisher allows no other public
host, no search/report endpoints, and never sends more than 25 trails per hour.
