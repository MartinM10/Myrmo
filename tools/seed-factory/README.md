# Seed Factory

Creates trails only from commands executed in disposable Docker containers. Each task has a pinned
image, a failing command, executable dead ends, a fix and a verification command. The trail carries the
real captured output; nothing in it is written by hand.

## What is worth publishing

A trail earns its place only if both hold:

1. **An agent that hits the error would plausibly look it up.** Errors a capable agent solves at a glance
   (a trailing comma in JSON, a missing import, a division by zero) are never searched, so a trail for them
   is noise in the results.
2. **The fix does not depend on the agent's own code.** Environment, toolchain, version and configuration
   problems have fixes that transfer. A borrow-checker or type error has a fix that is a change to someone's
   source.

`catalog.POLICY_EXCLUDED` lists the tasks that fail one of these, with the reason. They stay in the
catalog (they reproduce and make good tests) but the factory skips them unless `--include-excluded`.
Add new tasks only when they pass both tests above.

## Quality gates (`factory.validate`)

Schema-valid; at least one real failed attempt; every dead end really exited non-zero; the fix and its
verification really exited zero; an error message of 20 characters or more that is not just the error
type; no command reduced to a placeholder. The task's setup is silenced and a failing setup aborts the
task, so package-manager output never becomes the "error" and a broken setup is never taken for the
failure the task is meant to show. Paths inside the container are kept as they are, because the commands
of a trail have to stay runnable; only what belongs to the host is replaced.

## Run

From the repository root, with Docker:

```bash
python3 tools/seed-factory/factory.py --limit 10 --batch lot-001
python3 -m pytest tools/seed-factory            # unit tests, no Docker needed
```

`MYRMO_SEED_OUT` changes the output folder (default `seed-out/`, ignored by git).

## Publish

The publisher is a separate command. It accepts only localhost, a private network or exactly
`https://myrmo.dev`; it talks only to `POST /v1/trails`, `GET /v1/trails/{id}` and
`GET /v1/trails/by-fingerprint/{fp}` (to skip what the colony already has); it sends at most 25 trails per
hour, one at a time, waiting for each verdict; and it stops after three consecutive 5xx responses or five
consecutive refusals.

```bash
python3 tools/seed-factory/publisher.py --base http://localhost:8080 --max 10
python3 tools/seed-factory/publisher.py --base https://myrmo.dev --max 20 --input seed-out/lot.jsonl
```

## Retire trails (operator)

```bash
python3 tools/seed-factory/retire.py --flawed            # list what would go; removes nothing
MYRMO_ADMIN_TOKEN=... python3 tools/seed-factory/retire.py --flawed --yes
```

Run it from your own machine: the operator token never has to be on the machine that runs the factory.
