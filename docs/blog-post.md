# Giving Claude Code a real memory, with MongoDB

If you use Claude Code, you already have a form of memory. This post walks through how that memory works today, why it starts to hurt as you use it more, and how we replaced it with MongoDB Atlas so memory becomes searchable, shared, and cheap to carry around.

## 1. How Claude Code uses memory today

Think of Claude Code like an assistant who takes notes on index cards.

Two kinds of cards exist:

- **CLAUDE.md files.** These are notes you write yourself: house rules, project facts, things you want followed every time. You keep them in your project folder or in your home folder.
- **An auto-memory directory.** As you work, Claude Code also writes its own notes to files on your machine: things it learned, summaries of past sessions, useful context.

At the start of every session, Claude Code opens the folder, reads every card in it, and loads all of it into the conversation before you type a single word. That is the whole system: plain files, on one machine, read start to finish, every single time.

## 2. What the problem is

That index-card box has four cracks that get wider the more you use it.

**It lives on one laptop.** The notes are just files on disk. Switch to your other laptop, or hand the project to a teammate, and none of that memory comes with you. You start from zero.

**You cannot search it.** There is no way to ask "what did we decide about the login bug three weeks ago?" The only option is loading the entire box and reading through it yourself, or hoping it's still in there somewhere.

**It grows stale.** Nothing ever gets cleaned up automatically. Old notes about a bug you fixed months ago sit next to notes from yesterday, with no distinction between them, and no removal.

**Every session pays for the whole box.** Because Claude Code loads everything in the folder at the start of a session, a bigger memory folder means more tokens spent before you've asked your first question. The box helps you, but it also has a bill attached, and the bill grows every time you add a card.

None of this is a design flaw so much as a natural ceiling: files-on-one-machine is a fine starting point, but it was never built to be searched, shared, or kept tidy over time.

## 3. How we solve it with MongoDB

We replaced the file box with a small pipeline built on MongoDB Atlas. The pieces:

- **Capture.** As you work, hooks quietly write down what happened: things you asked to remember, useful facts from the conversation, session summaries. These raw notes go into MongoDB as "observations." Nothing is lost, and nothing needs to be perfectly organized yet.
- **Consolidation.** A separate job runs offline (on a schedule, or on demand) and does the tidying for you. It reads the raw observations, uses a language model to pull out the actual facts, and merges duplicates into clean, standalone statements we call "beliefs." Repeating the same fact five different ways collapses into one clear belief.
- **The brief.** At the start of a new session, instead of loading every note ever written, Claude Code loads one small, compiled summary called the brief: a short, curated set of the beliefs that matter for this project (plus a small global brief for facts that apply everywhere). It is built ahead of time, not assembled on the fly.
- **Search on demand.** If Claude needs something that is not in the brief, it can ask for it. A memory_search tool, exposed over MCP, searches by both meaning and keywords at once (more on this below) and returns just the relevant beliefs, not the whole database.

The shape of the change is simple: capture everything, distill it offline, load only a small distilled summary by default, and search for the rest only when it's actually needed.

```
memory_search("what did we decide about the login bug retries?")
  -> returns the 3 most relevant beliefs, not the whole history
```

## 4. Cost and context advantages for a builder

The old system charged you tokens for the entire memory folder, every session, whether you needed all of it or not. The new system flips that.

- **The brief is small and fixed in size**, not "as big as everything you've ever recorded." Instead of loading, say, an ever-growing folder of notes, a session might load a brief capped at a couple of thousand tokens, roughly a page of curated notes (defaults: 800 tokens for the global brief, 1200 per project). That difference repeats every single session, so it compounds fast over a busy week.
- **Search is pay-as-you-go.** Most sessions never call memory_search at all. When one does, it pulls back a handful of relevant beliefs instead of a firehose, so the token cost of "remembering something specific" stays small and proportional to the question, not to the size of your history.
- **The expensive step happens offline, on cheap models.** Turning raw observations into clean beliefs uses a language model, but that work happens in the consolidation job, not in your interactive session, and it can run on a smaller, cheaper model since extraction is a narrower task than open-ended conversation. You are not paying premium, interactive-model prices just to keep your memory tidy.

Put together: fewer tokens loaded at the start of every session, smaller and more targeted token spend when you do search, and the costly cleanup work pushed to the cheapest place it can run.

## 5. The actual advantages of MongoDB in this process

A natural question: why MongoDB specifically, and not a file, or a separate vector database bolted onto a separate search engine?

The answer is that MongoDB Atlas lets one database do every job this pipeline needs, instead of stitching several specialized systems together:

- **Documents, as-is.** Observations and beliefs are just documents. No separate schema-mapping layer, no translation step between "how the app thinks about a belief" and "how the database stores it."
- **Vector search, built in.** Beliefs get embedded (turned into a list of numbers that captures their meaning) and that embedding lives right next to the belief text, in the same collection. No separate vector database to run, sync, or pay for.
- **Keyword search, built in.** Atlas also runs full-text (BM25) search on the same data, so exact terms and names are matched, not just "close in meaning."
- **Hybrid search, in one query.** A single `$rankFusion` stage combines the vector search and the keyword search into one ranked result, weighted so meaning-based matches are favored while exact keyword hits still count. One aggregation pipeline, one round trip, both retrieval styles.
- **Reranking, in the same database.** After the hybrid search narrows the field, a rerank step re-orders the top results for precision, using a native `$rerank` stage in the database when available, with an automatic fallback path if it is not.
- **Server-side embeddings.** With autoEmbed, MongoDB can generate the embedding for a piece of text at write time and query time, so the application does not have to call an embedding service itself and manage that extra pipeline.
- **Automatic cleanup, for free.** TTL indexes let old observations and stale beliefs expire and disappear on their own, on a schedule, with no separate cleanup script to write or maintain.
- **One query language for everything.** Capture, consolidation, search, and cleanup all speak the same MongoDB aggregation pipeline. There is no second system with its own API to learn, monitor, and keep in sync.
- **Even the AI provider can be MongoDB-managed.** Atlas offers its own model API keys for embeddings and reranking, so a project can run this whole system without holding a separate account or key with an outside AI vendor if it prefers not to.

The net effect: one database handles storage, semantic search, keyword search, hybrid ranking, reranking, embedding generation, and expiry. What would otherwise be four or five separate services, each with its own bill, its own uptime, and its own integration work, collapses into one place to look and one system to operate.
