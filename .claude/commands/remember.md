---
allowed-tools: Bash, Write
description: Save a memory to the shared Atlas memory store
argument-hint: [text to remember]
---

The argument text below may contain quotes or shell metacharacters. Do not
type it into a shell command. Instead:

1. Use the Write tool to write the exact text of $ARGUMENTS, and nothing else
   (no extra quoting, no added commentary), to the file
   `/tmp/.mongo-claude-memory-remember-payload.txt`.

2. Run this exact command using the Bash tool:

```
node /Users/teja.boddapati/Desktop/mongo-claude-memory/dist/capture/remember.js --file /tmp/.mongo-claude-memory-remember-payload.txt
```

3. Run this exact command using the Bash tool to remove the temp file:

```
rm -f /tmp/.mongo-claude-memory-remember-payload.txt
```

Relay the command's output from step 2 concisely to the user: report success
or the exact error message, do not add commentary or reformat it.
