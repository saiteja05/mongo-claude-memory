---
allowed-tools: Bash
description: Check Recall's MongoDB Atlas connectivity and index health
---

1. Run this exact command using the Bash tool:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/consolidation/cli.js" --doctor
```

2. Relay the command's output to the user verbatim: this is a diagnostic
   command, so exact output matters, do not summarize, reformat, or add
   commentary.

If the command fails with a `Cannot find module` error, dependencies have
not been installed yet: run the `recall-setup` skill, or run `npm install`
once inside `${CLAUDE_PLUGIN_ROOT}`, then retry.
