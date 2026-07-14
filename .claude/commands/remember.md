---
allowed-tools: Bash, Write
description: Save a memory to the shared Atlas memory store
argument-hint: [text to remember]
---

The argument text below may contain quotes or shell metacharacters. Do not
type it into a shell command. Instead:

1. Run this exact command using the Bash tool to create a fresh temp file,
   and note the exact path it prints (it will differ on every run):

```
mktemp -t mongo-claude-memory-remember
```

2. Use the Write tool to write the exact text of $ARGUMENTS, and nothing else
   (no extra quoting, no added commentary), to the path printed in step 1.

3. Run this exact command using the Bash tool, substituting the path from
   step 1 in place of `<path>`:

```
node /Users/teja.boddapati/Desktop/mongo-claude-memory/dist/capture/remember.js --file <path>
```

4. Run this exact command using the Bash tool to remove the temp file,
   substituting the same path from step 1 in place of `<path>`:

```
rm -f <path>
```

Relay the command's output from step 3 concisely to the user: report success
or the exact error message, do not add commentary or reformat it.
