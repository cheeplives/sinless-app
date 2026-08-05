# Findings

One file per pass doc per session, named:

```
YYYY-MM-DD-P<NN>[-<tag>].md
```

`-<tag>` only if the same pass runs twice in a day. Files are **append-only** —
correct a mistake by writing a new file, never by editing an old one. The full
header and body format is in [`../TEMPLATE.md`](../TEMPLATE.md#findings-file).

Each file records a summary count line plus one block per **non-PASS** result.
Passes are counted, not listed — that is deliberate, and it is what keeps these
aggregatable as they accumulate.

## Aggregating across sessions

```bash
grep -rn "FAIL$" docs/qa/findings/
```

```bash
grep -rln "JUDGEMENT" docs/qa/findings/
```

```bash
grep -rh "^Executed:" docs/qa/findings/
```

## Reading a finding months later

Every file names the app commit it ran against. A FAIL recorded against an old
commit may already be fixed — check the hash before acting on it. A finding is a
point-in-time observation, not a live bug list.

Open questions that came out of these runs live in
[`../JUDGEMENT-CALLS.md`](../JUDGEMENT-CALLS.md), which *is* live state and is
edited in place as the owner rules on them.
