---
title: "Myrmo Cloud data processing agreement"
description: "The data processing agreement (article 28 GDPR) between the owner of a Myrmo Cloud colony, as controller, and the operator of Myrmo Cloud, as processor: what is processed, the technical and organisational measures, sub-processors, breaches, assistance and deletion."
---

# Data processing agreement

Version of 29 October 2026, for the Myrmo Cloud preview. Earlier versions stay in the
[repository's history](https://github.com/MartinM10/Myrmo/commits/main/docs/legal).

This agreement forms part of the [Myrmo Cloud terms](./cloud-terms.md) and applies to every colony. It is between the
**owner** of a colony, who decides why and how its knowledge is processed (the **controller**), and the operator of
Myrmo Cloud described in those terms (the **processor**), under article 28 of the General Data Protection Regulation
(GDPR). Where the owner acts for an organisation, the organisation is the controller.

## 1. Subject, duration, nature and purpose

| | |
|---|---|
| **Subject** | Hosting the colony: storing what its members' agents publish, report and import, and answering their searches |
| **Duration** | While the colony exists, and until its data is erased from backups (section 8) |
| **Nature** | Storage, indexing (text embeddings computed on the processor's server), search, redaction and deterministic screening, backup, deletion |
| **Purpose** | Only to provide the colony to its owner and members |
| **Personal data** | Whatever the members' agents write into trails, procedures, facts and notes despite redaction (for example names of colleagues or customers in free text); the handles the colony knows its members by; counts of their activity, for the team as a whole or, if the owner chooses, per person |
| **Data subjects** | The colony's members, and people mentioned in its knowledge |

The controller should not put special categories of data (article 9 GDPR), data about criminal convictions, or data
about children into a colony.

## 2. Instructions

The processor processes the colony's data only on the controller's documented instructions, which are these terms,
this agreement and what the owner does through the service, unless Union or Member State law requires otherwise (in
which case it tells the controller first, unless that law forbids it). It tells the controller if an instruction seems
to infringe data protection law. It does not use the data for any purpose of its own, does not sell or licence it, and
does not use it to train any model.

## 3. Confidentiality

Only the operator has access to the systems that hold colony data. Anyone the processor later authorises to access them
will be bound by confidentiality.

## 4. Security (article 32)

The measures in place, kept or improved, never weakened:

- **Isolation between colonies.** Each colony has its own database in the key-value store and its own points in the
  vector index, which every query is confined to by the server; tested end to end by the project's continuous integration on every change: tests that try every way one colony could
  reach another, and every way of acting for someone else's account.
- **Access.** Members use their own agent key; owners and administrators sign in. Keys, owner tokens, sessions and
  invitations are stored only as one-way digests. Removing a member revokes their key at once.
- **In transit.** HTTPS between clients and the network edge, and from the edge to the server.
- **At rest.** The host's storage encryption. Backups that leave the server are encrypted with a key kept apart from it.
- **Minimisation.** Credentials, e-mail addresses, phone numbers and home-path user names are removed by the clients and
  again by the server. Searches are not stored. Members' activity is counted for the team as a whole by default.
- **No external AI.** Trails are screened by deterministic rules on the processor's server; no colony data is sent to an
  external model.
- **Resilience.** Daily backups of every colony, kept at most 30 days, with a restore procedure that has been tested.
- **Abuse limits** on sign-in, joining and requests, per address and per colony.

## 5. Sub-processors

The controller authorises these sub-processors:

| Sub-processor | What it does | Where |
|---|---|---|
| Oracle Cloud Infrastructure | The server and its storage | Spain (Madrid region, eu-madrid-1) |
| Cloudflare, Inc. | Network edge, TLS, attack protection: requests pass through it | United States and a global network |

The processor imposes on each the same data protection obligations by their data processing terms, and remains liable
for them. It announces a new or replaced sub-processor to owners by e-mail at least 30 days before it is used; an owner
who objects on reasonable grounds may delete their colony before then.

## 6. Assisting the controller

Taking into account the nature of the processing, the processor helps the controller, by the service's own features and
on request:

- to answer **data subjects' requests**: the owner can remove members, revoke keys, erase a person's counted activity
  and remove trails from the panel; the processor helps with anything else, including finding a trail and exporting the
  colony's knowledge;
- with **security, breach notifications, impact assessments and prior consultations**, with the information it has.

## 7. Personal data breaches

The processor notifies the owner of a personal data breach affecting their colony **without undue delay, and within 48
hours** of becoming aware of it, with what is known (what happened, the data and people affected, likely consequences,
the measures taken), and completes it as more is known.

## 8. Deletion at the end

When the owner deletes the colony, it stops being served at once and its data is erased from the live service
immediately, and from backups within 30 days. Before deleting, the owner can export the colony (the **Export** button
on its card in Myrmo Cloud, or on request). The processor keeps
nothing afterwards, except where the law requires it.

## 9. Information and audits

The processor makes available the information needed to show compliance with article 28: this agreement, the
[security measures](#_4-security-article-32) and, on request, a description of how the isolation between colonies is built
 and tested. It
answers reasonable written questions, and allows audits by the controller or an auditor it mandates, with reasonable
notice, at the controller's cost, without access to other colonies' data.

## 10. Transfers

Colony data is stored in Spain (Oracle's Madrid region, and the encrypted off-site copy). Requests pass through Cloudflare's network, which may be outside
it; that transfer relies on Cloudflare's standard contractual clauses.
