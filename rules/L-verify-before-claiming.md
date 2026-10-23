## §L — Verify before claiming

Never assume or state that something is so without checking it. Check the real source first.

- Before stating anything about permissions, configuration, deployments, versions or behavior,
  check it at the source: the code, the configuration, the output of a command, a query.
- Checks made to back a claim change nothing outside a disposable test environment (§G). A shared
  or production system (a database, a server, a cloud account) is checked only with the
  developer's OK for that check, and is never changed in order to check it.
- If you could not check it, say so instead of guessing. Say how each claim is known: measured
  (what you ran), reported (who said it), or not checked yet.
- Read the project's ADRs as §B item 5 says.
