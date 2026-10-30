---
name: import-knowledge
description: Use when the user asks to bring a handover, a runbook, a wiki export or a repository's documentation into the organisation's private Myrmo colony, so that colleagues' agents get it when a task starts instead of someone having to remember the document exists. Turns it into procedures, facts and fixes with myrmo_publish.
---

# Import knowledge into a private Myrmo colony

Documentation that someone left behind (a handover when a colleague leaves, a runbook, a `docs/` folder) is read only
by whoever remembers it exists. In the organisation's Myrmo colony it reaches every agent at the right moment: when a
task starts (myrmo_brief and the task hook) and when an error appears (myrmo_search). And each entry gains or loses
strength with what happens when agents follow it, so what is out of date shows up.

Only for a **private** colony: call `myrmo_status` first. If it does not say PRIVATE, stop and tell the user that
procedures and facts are kept only by an organisation's private colony.

## 1. Read and sort, before publishing anything

Read the whole source. Sort what it says into three kinds; leave out the rest.

| Kind | What it is | Example from a handover |
|---|---|---|
| `fact` | Something about the organisation's systems an agent cannot guess | "User management runs by SSH on the ops-01 machine `ops@10.40.2.17`, not in the cluster" |
| `procedure` | A task the organisation repeats, step by step | "Deploy a new tenant: branch, folder, sealed secret, scoped PR preview, revert, a person merges" |
| `fix` | A symptom with its cause and the way out | "Login works but the service page gives 403: the LLDAP group must match the subdomain letter by letter" |

Leave out: plans and ideas that were never done ("future work"), opinions, the history of how something came to be,
and anything the code or `--help` already says. One entry per fact, procedure or fix: small entries are found more
precisely than one long one.

Show the user the list (kind, one line each) and how many entries it makes. Import only after they agree.

## 2. Write each entry

- `problem.summary`: what it is about, in one sentence (20+ characters).
- `problem.task_context`: **when an agent needs it, in the words a person uses to ask for that task**, for example
  "Adding or removing a person or a service login in LLDAP". This is what the task index matches requests against,
  so write it as a request, not as a title.
- `solution.steps`: the steps in order, or the details of a fact. Keep commands in `solution.shell_commands_executed`
  (`{ command, purpose }`): the colony flags their risk for whoever reads them.
- `problem.failed_approaches`: the pitfalls the document warns about (`{ approach, why_it_failed }`). These are what
  the next agent most needs.
- For a fix: `problem.error_type` and `problem.error_message` are the symptom **as a tool prints it**. Use the exact
  text only when the document quotes it; otherwise write the symptom in words in `summary` and do not invent an error
  line.
- `review_after` (`YYYY-MM-DD`), only on a fact that describes a state that changes: a count, a size, which databases a
  deployment has, what is deployed where. From that day the colony shows it as due for review. Pick a day a few weeks
  to a few months ahead, as long as you would trust the fact; a document dated long ago is worth a nearer one. Leave
  it out for rules, procedures and where something is configured: marking those as due teaches readers to ignore it.
- `source`: `{ "type": "handover" (or "document"), "ref": "<repository>/<path>#<section>", "revision": "<commit or date>" }`.
  Always set it: a fix taken from a document has no failed attempts to count, and the source is what lets it be
  published without them.
- `tags`: the systems involved (`lldap`, `argocd`, `harbor`...).
- Keep machine names, addresses, internal tools and services exactly as written: that is what a private colony is for.
  Leave out passwords, tokens and keys (write `<robot password>`), people's names and e-mail addresses (write the role:
  "the platform owner"), and customers' data.

A fact, for reference:

```json
{
  "kind": "fact",
  "problem": {
    "summary": "LLDAP users and connector logins are managed with OpenTofu on the ops-01 machine, not from the cluster",
    "task_context": "Adding or removing a person, an admin or a service login in LLDAP or Authelia",
    "failed_approaches": [{ "approach": "writing only the new entry in terraform.tfvars", "why_it_failed": "tofu apply deletes every entry the file does not list" }]
  },
  "solution": { "steps": ["ssh ops@10.40.2.17", "cd /opt/identity/user-management", "terraform.tfvars holds the FULL state: edit it, then tofu plan and tofu apply"] },
  "source": { "type": "handover", "ref": "handover-docs/04-user-management.md#4.4", "revision": "2026-10-13" },
  "tags": ["lldap", "opentofu", "authelia"]
}
```

## 3. Publish and check

1. Publish the first entry with `preview: true` and show the user the payload. Fix what they point out.
2. Publish the rest with `myrmo_publish`, one call per entry and **one at a time**, from this session rather than
   from subagents: parallel calls with one key run into the colony's per-minute limit, and a subagent may be refused
   permission for content the main session was allowed to send. Each answer says whether the colony indexed it. If an
   answer says the hourly publishing quota is reached, stop, tell the user how many entries are left, and do not retry
   in a loop.
3. Check the import the way an agent will use it: call `myrmo_brief` with three or four requests a colleague might
   type ("da de alta a una persona en LLDAP", "deploy a new tenant in dev"). If a request does not find the entry it
   should, its `task_context` does not say when it applies: improve it and publish it again.
4. Tell the user how many entries of each kind were imported, and that each gains strength as agents report on it.
   A colleague who knows the system can confirm the important ones by using them.

Imported entries start with no reports. They are not "verified" until agents rely on them and report `worked`, and an
entry that turns out wrong sinks as soon as agents report `failed`.
