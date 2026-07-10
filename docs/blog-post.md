# Giving Claude Code a real memory, with MongoDB Atlas

Every large language model works inside a fixed context window: the entire working memory it has for a session. Your instructions compete for that space. So does the code it just read, the output of every tool it ran, the conversation so far, and any memory file loaded the moment the session started. Fill that window and the harness has to compact it: earlier turns get summarized down, and detail is gone for good. Anything you want a future session to know has to be written somewhere and reloaded next time, and reloading it costs window all over again. This is the actual problem a memory system has to solve, and it is the one most memory tooling quietly ignores.

## How Claude Code remembers today

Claude Code already has an answer of sorts. You write CLAUDE.md files: house rules, project facts, standing instructions to follow every session. Alongside them, Claude Code keeps an auto-memory directory where it writes its own notes as it works: things it learned, summaries of past sessions, useful context.

Both are plain files, on one machine. At the start of every session, Claude Code opens that folder and reads all of it into the context window before you type a word: files on disk, loaded start to finish, every time.

## Why that breaks down against a fixed window

Framed against the context window, the cracks are structural, not cosmetic.

Every file loaded at session start is context the model cannot spend on your actual code. The folder only grows: nothing in it expires, so notes from a bug fixed months ago sit next to yesterday's, indistinguishable and permanent. There is no search, so the only retrieval mechanism is "load everything and hope the answer is in there." And it lives on one laptop: switch machines, or hand the project to a teammate, and none of it travels with you.

None of this is a bug. Plain files were never built to be searched, budgeted, or shared: they were built to be read in full, which is exactly what a finite context window cannot afford forever.

## The fix: capture everything, load almost nothing

We rebuilt memory as a small pipeline on MongoDB Atlas, and the design principle is explicit: the context window should carry a distilled summary plus exactly what the current task needs, never the whole archive.

As you work, hooks capture what happened, things you asked to remember, facts surfaced in conversation, session summaries, and write them into MongoDB as raw observations. Nothing has to be organized at capture time; the goal is just to not lose anything.

A separate consolidation job runs offline, on a schedule or on demand. It reads the raw observations, uses an LLM to extract the real facts, and merges duplicates into clean, standalone statements called beliefs. Say the same thing five ways across five sessions and consolidation collapses it into one belief.

At the start of a new session, Claude Code does not reload the archive. It loads one small, pre-compiled brief: a token-capped summary of the beliefs that matter, by default 800 tokens for the global brief and 1200 tokens per project. If something outside the brief is needed, a memory_search tool exposed over MCP runs hybrid semantic and keyword search and returns just the relevant beliefs on demand.

```
memory_search("what did we decide about the login bug retries?")
  -> returns the most relevant beliefs, not the whole history
```

Capture everything, distill it offline, load a fixed small brief, search for the rest only when the task calls for it.

## What this means for cost and context, in practice

The old system billed you tokens for the entire memory folder, every session, regardless of whether the task needed any of it. This one does not scale that way.

The brief is fixed in size by configuration (the 800 and 1200 token caps above are the real defaults), not by how much you have ever recorded. Search is proportional to the question, not the archive: a query returns a handful of relevant beliefs rather than a firehose, so the cost of remembering something specific tracks what was asked, not how much history exists. And the expensive step, turning raw observations into clean beliefs, runs offline in the consolidation job on a smaller, cheaper model, since extraction is a narrower task than open-ended conversation, so none of that cost lands on your interactive session. Net effect: a smaller, predictable load every session, and more of the context window left for the work you actually came to do.

## Why MongoDB, specifically

The natural question is why one database, rather than a vector store bolted onto a search engine bolted onto a document store. Atlas already does every job this pipeline needs, so what would otherwise be four or five stitched-together services collapses into one system to run and operate.

Observations and beliefs are stored as documents, with no schema-mapping layer between how the application thinks about a belief and how it is stored. Vector search is built in, so embeddings live next to the belief text in the same collection rather than in a separate vector database to sync and pay for. Full-text BM25 search runs on the same data, so exact terms and names match even when they are not semantically close. A single `$rankFusion` aggregation stage combines vector and keyword results into one ranked hybrid result, in one round trip. A native `$rerank` stage reorders the top hybrid results for precision, right in the database. With autoEmbed, MongoDB generates embeddings server-side, at both write time and query time, so the application never has to run its own embedding calls. TTL indexes expire stale observations and beliefs automatically, with no cleanup script to maintain. Capture, consolidation, search, and expiry all speak the same aggregation pipeline: one query language for the whole system. Atlas's own model API keys mean even the embedding and reranking provider can be MongoDB-managed, so the project need not hold a separate account with an outside AI vendor.

Storage, semantic search, keyword search, hybrid fusion, reranking, embedding generation, and expiry, in one database instead of five.

## Where this leaves you

Claude Code gets a memory that scales with how long you use it, not with how much context it can hold in one sitting: a small, curated brief every session, and full recall on demand instead of by default. It runs on any MongoDB Atlas cluster, and setup is a handful of environment variables, no new infrastructure to stand up.
