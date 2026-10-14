---
title: "Employees and data protection in a private colony"
description: "What an organisation's private colony keeps about the people it serves, for how long and why, what is off by default, how a person's data is erased, and what an organisation using it under the GDPR should do."
---

# Employees and data protection

A private colony is run by the organisation that uses it. For the data it keeps about its people, that organisation is
the **controller** under the GDPR (and similar laws). If a provider hosts the colony for it, that provider is its
**processor**, and the two need a data processing agreement (article 28). This page says what the software keeps and how to run it lawfully. It
is not legal advice: check your obligations with whoever advises you on data protection and labour law.

## What it keeps about a person

| Data | When | Kept | Why |
|---|---|---|---|
| Name (a handle, not an e-mail) and a digest of the access key | Always | Until the key is revoked | Access control |
| When the key was last used | Always | Until erased | Managing access: unused keys are revoked |
| Which Myrmo client and version their agents run | Always | Until erased | Support: telling who runs an outdated client |
| Searches, publications and reports per day | Only with `MYRMO_PEOPLE_DETAIL=named` | 90 days | The organisation chose to see adoption per person |
| Reuse records ("ana's agent used luis's trail") | Names only with `named` | Named: 90 days. Otherwise without names | Showing that people reuse each other's work |
| Task requests nobody's knowledge answered | Only if recording is on; the person only with `named` | 30 days | Knowing what to write down next |
| Author of what they published | Always | Until erased (the entry stays, without the name) | Nobody may reinforce their own entries |
| Measured effort (tokens, time, model) | From the Claude Code plugin, where the colony collects it | Only as totals per error and day, never per person | Showing what the colony saves |
| Operator actions naming them (key created, revoked) | Always | The last 200 actions | Audit of who changed access |

Short-lived technical records that name a person or their key: rate-limit counters (minutes), one-report-a-day markers
(a day), a note that a lookup was held out (two days), a marker against counting the same effort record twice (an hour).

By default (`MYRMO_PEOPLE_DETAIL=aggregate`) the colony keeps **no activity per person**: the team's searches,
publications, reports and reuse are counted as a whole. That is enough to know whether the colony is used and whether
people reuse each other's work. It is also what the GDPR asks of software by default (data minimisation, article 5;
data protection by design and by default, article 25).

The colony never keeps the text of a search or of a task request, except the unanswered requests above. What people
publish is the organisation's knowledge: credentials, people's names, e-mail addresses and customer data are removed
on their machine and again by the colony.

## Before naming people

Counting each person's activity is monitoring their work. Before setting `MYRMO_PEOPLE_DETAIL=named`:

- **Have a purpose and a legal basis** that would survive a challenge, usually legitimate interest (article 6(1)(f)), with
  an assessment that weighs it against the employees' interests. Seeing who uses a tool rarely needs names; "the
  team" usually does the job.
- **Tell the people** what is kept, why, for how long and their rights, before it starts (article 13). The invitation
  that `keys add` and the panel produce already says what the colony keeps about the person, and the clients show it
  (`myrmo_status`, `npx myrmo-mcp doctor`).
- **Involve the workers' representatives where national law requires it.** In Spain, for example, the works council
  issues a report before a system of work control is introduced (article 64.5 of the Estatuto de los Trabajadores), and
  the employer has to set and communicate its criteria for monitoring digital tools (article 87 of the LOPDGDD).
- **Consider a data protection impact assessment** (article 35): systematic monitoring of employees is one of the cases
  where supervisory authorities expect one.
- **Never use it to rate individuals.** Search counts say nothing about the quality of anyone's work.

The colony tells every client whether it names people (`people_detail` in `GET /v1/version`), so nobody is named without
being able to see it.

## The hold-out

With a hold-out (`MYRMO_HOLDOUT_PERCENT`, 0 by default, 20 at most), a share of error lookups is answered as if the colony
knew nothing, so the colony can be measured against a randomised control group. It withholds help from some people,
some of the time: keep it small (5 is enough), tell the team it is on, and turn it off once the measurement is done.
Clients show the percentage to the person.

## Rights of the people it serves

- **Access** (article 15): the operator sees everything the colony keeps about a person in the panel (People, Activity
  log, the authors in the Colony tab).
- **Erasure** (article 17): in the panel, **Erase** next to the person, or `DELETE /v1/admin/people/{name}?erase=true`.
  It revokes their key and removes their counts, last use, client versions, their name from reuse records, knowledge
  gaps and the audit list, and their name as the author of what they published, which stays as the organisation's
  knowledge. Backups taken before the erasure keep the old data until they rotate out (14 days by default): restore
  one, and erase again.
- **Objection to measured effort**: `npx myrmo-mcp config effort off` on their machine, or `MYRMO_EFFORT=off`.

## What the organisation keeps under its own control

The colony runs on the organisation's machine, sends nothing to the public colony or to any outside service in the
private setup (no decision model), and its settings, operator token and salt live in a file only its operator can
read. Backups hold everything the colony knows: keep them as private as the colony (`chmod 700`).
