# You keep re-teaching Claude Code the same things. Stop paying for that.

You know the moment. Forty minutes into a session, Claude Code compacts the conversation, and the decision you made together at minute five, use the retry queue, not the webhook, is gone. It confidently suggests the webhook. You correct it, again, and the correction costs you context window, again.

Or the Monday version: you open a fresh session and spend the first ten minutes re-establishing what any teammate would already know. We use pnpm. The CI gate is build plus test. Staging deploys from the release branch. You said all of this last week. The model was there. It just does not remember, because a session is the memory, and the session ended.

If you use Claude Code every day, you have already built a coping mechanism for this. It is called CLAUDE.md, and it is why yours is 400 lines long.

This post is about replacing that coping mechanism with an actual memory engine, built on MongoDB Atlas. The headline capability, the one nothing in the flat-file world gives you: **compaction wipes conversation history, not memory.** The brief that carries your standing facts is re-injected after every compaction, so the decision from minute five survives minute forty. The rest of the post is how, and what it costs.

## The coping mechanism is the problem

CLAUDE.md and the auto-memory folder are Claude Code's built-in answer, and for a while they work. You write down the house rules. Claude writes down its own notes. Every session starts by loading all of it.

Then the failure modes arrive, and every one of them shows up on your token bill or in your context window.

**You pay for all of it, every session, whether the task needs it or not.** The memory folder is loaded front to back at session start. The note about a bug you fixed in March is billed alongside the convention you actually need today, and both of them displace code the model could otherwise be reading. Memory that grows forever, loaded into a window that does not, is a subscription whose price only goes up.

**Recall is discretionary, so it is unreliable.** Auto-memory surfaces what the model decides is relevant. Some sessions it recalls the right thing, some sessions it does not, and you cannot tell which kind of session you are in until it suggests the webhook again. A memory you cannot count on is a memory you re-state defensively, which means you pay for the fact twice: once in the file, once in your prompt.

**There is no search, only "load everything."** When the fact you need did not make it into what got loaded, there is no second chance. You cannot ask the memory a question. The retrieval strategy is hope.

**It lives on one laptop.** Switch machines, spin up a second worktree, onboard a teammate, and the accumulated memory stays behind. Everything your Claude learned about the project is trapped in a folder on one disk.

None of that is a bug in Claude Code. Flat files were never built to be searched, ranked, budgeted, or shared. They were built to be read in full, which is exactly the one thing a finite context window cannot afford forever.

## "Or I could just prune my CLAUDE.md"

Fair. A hand-curated hundred lines is free, and if that is genuinely all you need, keep it. This system does not replace hand-written instructions anyway; your CLAUDE.md keeps working untouched.

But be honest about what pruning is: you, doing the memory system's job by hand, forever. You are the capture pipeline (remembering to write things down mid-flow), the consolidation job (noticing duplicates and stale facts on your own time), and the ranking function (deciding what earns a line). And even a perfectly pruned file still cannot do the four things that matter most: everything you pruned away is simply gone (there is no searching for a fact that did not make the cut), it cannot follow you to another machine or teammate, it cannot capture the decisions you never thought to write down (the transcript could), and the parts Claude maintains for itself, the auto-memory folder, are recalled at the model's discretion, not guaranteed. That is the gap this engine closes: it does the curation you were doing manually, continuously, and keeps the long tail queryable instead of deleted.

## What you would actually want, if you were designing it

Strip away the implementation and the wish list is short:

1. **Never lose anything.** Every decision, correction, and hard-won fact gets captured, without you doing bookkeeping mid-flow.
2. **Load almost nothing.** Session start should cost a small, fixed number of tokens, no matter how many months of history exist behind it.
3. **Deterministic recall for the facts that matter.** The house rules should be present every session, guaranteed, not surfaced at the model's discretion.
4. **Searchable recall for everything else.** When you ask "what did we decide about the rerank fallback," the answer should come back from a query, not from luck.
5. **Survives compaction, machines, and teammates.** Memory should be a durable service the session talks to, not a file the session drags around.
6. **Never breaks a session.** If the memory system is down, the worst case should be a session that behaves like stock Claude Code.

That list is the spec for what we built. The storage engine underneath it is MongoDB Atlas, and by the end of this post the reason will be obvious: every capability on that list maps to something Atlas already does natively.

## The engine: capture everything, distill offline, inject a fixed brief

The system is a small pipeline wired into Claude Code's official extension points, hooks and an MCP server, nothing forked or proxied. It has three moving parts.

**Capture is free-flowing and dumb.** As you work, hooks append raw observations to MongoDB: session transcript summaries at `SessionEnd`, anything you type starting with `#`, anything you save with `/remember`, anything Claude writes through a `memory_write` tool. No organizing, no judgment at capture time. The goal is only to not lose anything, which is requirement one.

**Consolidation is where judgment happens, offline, off your bill.** A scheduled job (cron, every 15 minutes by default) reads pending observations and uses an LLM to extract the durable facts, merge duplicates, and retire superseded versions. Tell it the same thing five ways across five sessions and it converges on one clean belief with provenance back to the observations that produced it. This is the expensive step, and it runs on a smaller model, outside your interactive session, so the cost of organizing memory never lands in your context window or your session latency.

Here is what that looks like on real input. Five observations accumulate across three sessions, three mined from transcript summaries, two typed by hand:

```
[transcript] "...decided against the webhook approach for payment
             notifications, going with the retry queue since Stripe's
             webhook delivery isn't guaranteed ordered..."
[transcript] "...user corrected me: retries should use the queue, not
             webhooks. Applied to notifications.ts..."
[# capture]  "# payment notifications go through the retry queue, never webhooks"
[transcript] "...added exponential backoff to the retry queue consumer..."
[/remember]  "retry queue backoff is capped at 5 attempts, then dead-letter"
```

The consolidator's LLM pass extracts, deduplicates, and merges those into two beliefs:

```json
{ "text": "Payment notifications go through the retry queue, never webhooks
           (Stripe delivery is not guaranteed ordered).",
  "type": "convention", "scope": "project", "importance": 0.9 }

{ "text": "Retry queue uses exponential backoff, capped at 5 attempts,
           then dead-letters.",
  "type": "convention", "scope": "project", "importance": 0.7 }
```

Three sessions of scattered phrasing became two standalone facts, each with provenance back to the observations that produced it. The first one is exactly the decision from this post's opening paragraph, and because it ranks high, it makes the brief: the next session, and every session after a compaction, starts already knowing it. The webhook suggestion never comes back.

**Recall is a fixed brief plus on-demand search.** At every session start, and again after every compaction and resume, a hook injects one pre-compiled brief: the top-ranked beliefs, capped at 800 tokens globally plus 1,200 per project. That is the whole deterministic load, requirements two and three in one document read, a single indexed `findOne`, about 10 milliseconds, no embedding call on the hot path. For the long tail that did not make the cap, a `memory_search` MCP tool answers questions on demand:

```
"What did we decide about the rerank fallback order?"
  -> memory_search runs hybrid vector + keyword search
  -> returns the three relevant beliefs, not the whole history
```

If Atlas is unreachable, every hook fails open and exits clean. Your session behaves like stock Claude Code minus one brief. Requirement six, and the reason you can adopt this without adding a new way for your tooling to break.

## The cost math, concretely

Here is the part that made us build it rather than keep coping.

With file-based memory, session-start cost is proportional to everything you have ever recorded. It only grows, and it is billed on every session, relevant or not.

With this engine, session-start cost is a constant you chose: at the default caps, roughly 2,000 tokens, whether the history behind it is a week or a year. Search cost is proportional to the question, a handful of beliefs per query, not the archive. And the LLM work of distilling memory runs offline on a cheaper model, so your interactive sessions carry none of it.

Memory that scales with how long you use it. Session cost that does not.

## Why MongoDB Atlas, and not a stack of five services

Look back at the pipeline and count the capabilities it needs: document storage, vector search, keyword search, a way to fuse the two, reranking, server-side embedding, and automatic expiry. The conventional build is a document store, plus a vector database to sync embeddings into, plus a search engine, plus glue code to merge results, plus a cleanup job. Five systems, four sync boundaries, each one a place for memory to silently rot.

Atlas does all of it in one database:

- **Beliefs are documents**, embeddings stored on the same document as the text they embed. Nothing to sync.
- **`$vectorSearch` and BM25 full-text search run on the same collection**, so a paraphrase and an exact identifier both have a path to the right belief.
- **`$rankFusion` fuses both arms in a single aggregation stage**, one round trip, weighted toward semantic match.
- **Native `$rerank` reorders the top candidates for precision inside the database**, with the Voyage rerank API as an automatic fallback.
- **`autoEmbed` can generate embeddings server-side** at write and query time, so the application ships no embedding code at all in that mode.
- **TTL indexes expire stale observations and tombstoned beliefs on their own.** The cleanup script does not exist because it does not need to.
- Even the embedding and rerank credentials can be Atlas model API keys, so the whole memory stack, storage through AI, can run on one vendor relationship you already have.

One system to operate, one query language end to end, and a memory that lives in a cluster any machine or teammate can reach, which quietly solves the one-laptop problem too.

## Try it

Straight talk about setup cost: this is a real pipeline, not an npm install. You need an Atlas cluster (the free tier works), one API key for embeddings (a Voyage key, or an Atlas model API key so it all stays on your MongoDB account), one credential for the consolidator's LLM (an Anthropic key or AWS credentials for Bedrock), three hooks, an MCP server registration, and a cron line. If you already have a cluster, budget about fifteen minutes. If you do not, add ten for creating one.

Here is the whole thing. Build and create the indexes (idempotent, safe to re-run):

```bash
npm install && npm run build
export MDB_MCP_CONNECTION_STRING="mongodb+srv://..."
export VOYAGE_API_KEY="..."          # or an Atlas model API key + VOYAGE_BASE_URL=https://ai.mongodb.com
export ANTHROPIC_API_KEY="..."       # or AWS credentials + LLM_PROVIDER=bedrock
npm run setup:indexes
```

Wire the hooks in Claude Code's `settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|compact|resume",
      "hooks": [{ "type": "command", "command": "node /path/to/mongo-claude-memory/dist/hooks/sessionStart.js" }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{ "type": "command", "command": "node /path/to/mongo-claude-memory/dist/hooks/userPromptSubmit.js" }]
    }],
    "SessionEnd": [{
      "hooks": [{ "type": "command", "command": "node /path/to/mongo-claude-memory/dist/hooks/sessionEnd.js" }]
    }]
  }
}
```

Register the MCP server (`node dist/mcp/server.js`, stdio) so `memory_search`, `memory_write`, and `memory_forget` show up as tools, and schedule the consolidator:

```
*/15 * * * * cd /path/to/mongo-claude-memory && node dist/consolidation/cli.js
```

That is the entire footprint, and every piece of it fails open: if the cluster is unreachable or a key is wrong, the hooks silently no-op and you get stock Claude Code. The worst outcome of trying it is the tool you already have. Removing the three registrations returns you to stock with zero residue.

The best outcome is the one that motivated all of this: you stop being your agent's memory, and it starts being yours.
