import path from "node:path";
import { fileURLToPath } from "node:url";
import { Db } from "mongodb";
import { getDb, closeDb } from "./client.js";
import { loadConfig } from "../config.js";
import { OBSERVATIONS, BELIEFS, BRIEFS, LOCKS } from "./schema.js";

/**
 * Idempotent Atlas setup: creates collections and indexes if they do not
 * already exist. Safe to re-run at any time. Never prints the connection
 * string, only progress messages.
 */

async function ensureCollection(db: Db, name: string): Promise<void> {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length > 0) {
    console.log(`[collections] "${name}" already exists, skipping`);
    return;
  }
  await db.createCollection(name);
  console.log(`[collections] created "${name}"`);
}

async function ensureTtlIndex(db: Db): Promise<void> {
  const collection = db.collection(OBSERVATIONS);
  const existing = await collection.indexes();
  const found = existing.find((idx) => idx.name === "expiresAt_ttl");
  if (found) {
    console.log(`[indexes] "${OBSERVATIONS}.expiresAt_ttl" already exists, skipping`);
    return;
  }
  await collection.createIndex(
    { expiresAt: 1 },
    { name: "expiresAt_ttl", expireAfterSeconds: 0 }
  );
  console.log(`[indexes] created TTL index "${OBSERVATIONS}.expiresAt_ttl"`);
}

async function ensureBeliefsCompoundIndex(db: Db): Promise<void> {
  const collection = db.collection(BELIEFS);
  const existing = await collection.indexes();
  const found = existing.find((idx) => idx.name === "project_scope_status");
  if (found) {
    console.log(`[indexes] "${BELIEFS}.project_scope_status" already exists, skipping`);
    return;
  }
  await collection.createIndex(
    { project: 1, scope: 1, status: 1 },
    { name: "project_scope_status" }
  );
  console.log(`[indexes] created compound index "${BELIEFS}.project_scope_status"`);
}

async function ensureBeliefsTtlIndex(db: Db): Promise<void> {
  const collection = db.collection(BELIEFS);
  const existing = await collection.indexes();
  const found = existing.find((idx) => idx.name === "archived_tombstoned_ttl");
  if (found) {
    console.log(`[indexes] "${BELIEFS}.archived_tombstoned_ttl" already exists, skipping`);
    return;
  }
  await collection.createIndex(
    { updated_at: 1 },
    {
      name: "archived_tombstoned_ttl",
      expireAfterSeconds: 7776000,
      partialFilterExpression: { status: { $in: ["archived", "tombstoned"] } },
    }
  );
  console.log(`[indexes] created TTL index "${BELIEFS}.archived_tombstoned_ttl"`);
}

async function ensureSearchIndex(
  db: Db,
  collectionName: string,
  name: string,
  type: "vectorSearch" | "search",
  definition: Record<string, unknown>
): Promise<void> {
  const collection = db.collection(collectionName);
  try {
    const existing = await collection.listSearchIndexes(name).toArray();
    if (existing.length > 0) {
      console.log(`[search indexes] "${collectionName}.${name}" already exists, skipping`);
      return;
    }
  } catch (err) {
    // listSearchIndexes can fail against non-Atlas deployments (e.g. no
    // mongot); surface that clearly instead of masking it as "already exists".
    console.log(
      `[search indexes] could not list search indexes on "${collectionName}" ` +
        `(this requires Atlas): ${err instanceof Error ? err.message : "unknown error"}`
    );
    return;
  }

  try {
    await collection.createSearchIndex({ name, type, definition });
    console.log(`[search indexes] requested creation of "${collectionName}.${name}" (type: ${type})`);
  } catch (err) {
    // createSearchIndex can fail for indexes that depend on preview features
    // (e.g. autoEmbed for beliefs_vec_auto) not enabled on a given Atlas
    // cluster. Log and continue so one unsupported index never blocks the
    // remaining baseline indexes from being created.
    console.log(
      `[search indexes] could not create "${collectionName}.${name}" ` +
        `(type: ${type}): ${err instanceof Error ? err.message : "unknown error"}`
    );
  }
}

export async function setupIndexes(): Promise<void> {
  const db = await getDb();
  const config = loadConfig();

  await ensureCollection(db, OBSERVATIONS);
  await ensureCollection(db, BELIEFS);
  await ensureCollection(db, BRIEFS);
  await ensureCollection(db, LOCKS);

  await ensureTtlIndex(db);
  await ensureBeliefsCompoundIndex(db);
  await ensureBeliefsTtlIndex(db);

  if (config.embeddingMode === "appside") {
    await ensureSearchIndex(db, BELIEFS, "beliefs_vec", "vectorSearch", {
      fields: [
        {
          type: "vector",
          path: "embedding",
          numDimensions: 1024,
          similarity: "cosine",
          quantization: "scalar",
        },
        { type: "filter", path: "project" },
        { type: "filter", path: "scope" },
        { type: "filter", path: "status" },
      ],
    });
  }

  // Only the currently configured mode's index is created here, not both:
  // autoEmbed bills Atlas for computing an embedding for every belief's text
  // server side, so creating beliefs_vec_auto while running in appside mode
  // would mean paying for embedding computation nobody ever queries.
  // Conversely, keeping beliefs_vec around while running in auto mode is
  // wasted write/maintenance overhead for an index nothing reads. If
  // EMBEDDING_MODE is switched later, re-run setupIndexes() to create the
  // newly-needed index (idempotent, see ensureSearchIndex's already-exists
  // check via listSearchIndexes). Note: switching modes does NOT
  // automatically drop the old mode's now-unused index, it stays in place
  // until manually dropped, which is out of scope here (no drop code is
  // being added).
  if (config.embeddingMode === "auto") {
    await ensureSearchIndex(db, BELIEFS, "beliefs_vec_auto", "vectorSearch", {
      fields: [
        {
          type: "autoEmbed",
          path: "text",
          model: config.voyageModel,
          modality: "text",
        },
        { type: "filter", path: "project" },
        { type: "filter", path: "scope" },
        { type: "filter", path: "status" },
      ],
    });
  }

  await ensureSearchIndex(db, BELIEFS, "beliefs_text", "search", {
    mappings: {
      dynamic: false,
      fields: {
        text: { type: "string" },
        type: { type: "token" },
        project: { type: "token" },
        scope: { type: "token" },
        status: { type: "token" },
      },
    },
  });

  // briefs are keyed by their default _id index: "brief:global" or
  // "brief:<project>". No additional index is needed beyond the default.
  console.log(
    `[indexes] "${BRIEFS}" documents are keyed by _id ("brief:global" or "brief:<project>"); ` +
      "the default _id index already enforces uniqueness"
  );

  console.log("Index setup complete.");
}

async function main(): Promise<void> {
  try {
    await setupIndexes();
  } finally {
    await closeDb();
  }
}

// Only run main() when this file is the actual entry point (node dist/db/setupIndexes.js),
// never when imported as a module (e.g. by tests exercising setupIndexes() directly).
const isEntryPoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntryPoint) {
  main().catch((err) => {
    console.error("Index setup failed:", err instanceof Error ? err.message : "unknown error");
    process.exitCode = 1;
  });
}
