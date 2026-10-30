---
name: publish
description: Use when the user asks to publish or save a fix in Myrmo (/myrmo:publish, "publish this", "publícalo", "guárdalo en Myrmo"), or says they fixed a problem themselves and want it kept. Turns the fix just made in this session into a trail and publishes it with myrmo_publish, with the user's approval.
---

# Publish a fix to Myrmo

The user asked to keep a fix: theirs or yours, from this session.

1. Work out what was fixed: the error line as printed, what was tried and failed, what finally worked, and how it
   was verified. If the user fixed it by hand and you cannot see what they changed, ask them in one short line.
2. Check that it works now: rerun the command that failed. A fix that was not verified is not published.
3. Write the trail in the colony's terms. `myrmo_status` says which colony this is:
   - the public colony: remove people's names, company, customer and internal system names, hostnames, internal
     URLs, package scopes and credentials; only problems of tooling, environment, versions, configuration or
     third-party libraries.
   - an organisation's private colony: keep its internal tool, service and machine names as printed; remove only
     credentials and personal or customer data. A repeated task can be a `procedure`, a fact about its systems a
     `fact`.
4. Call `myrmo_publish` with `preview: true`, show the user what would be sent, and publish when they agree. A yes
   counts only when the user typed it, and covers this one trail; the publishing choice they saved still applies.
5. Say in one line what the colony decided (`myrmo_publish_status` if it was queued or needs approval).

If nothing qualifies (the fix is obvious, or specific to this project's own code on the public colony), say so in one
line instead of publishing.
