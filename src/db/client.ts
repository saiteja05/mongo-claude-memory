import { MongoClient, Db } from "mongodb";
import { loadConfig } from "../config.js";

let clientPromise: Promise<MongoClient> | null = null;

/**
 * Returns a lazily-connected, reused Db handle. Never logs the connection
 * string; connection errors are rethrown as a generic message since the
 * original error may embed the URI.
 */
export async function getDb(): Promise<Db> {
  const config = loadConfig();

  if (!clientPromise) {
    const client = new MongoClient(config.mongodbUri);
    clientPromise = client.connect().catch((err) => {
      clientPromise = null;
      throw new Error(
        `Failed to connect to MongoDB (see original error for details, redacted here): ${
          err instanceof Error ? err.name : "unknown error"
        }`
      );
    });
  }

  const client = await clientPromise;
  return client.db(config.mongodbDb);
}

export async function closeDb(): Promise<void> {
  if (!clientPromise) return;
  const client = await clientPromise.catch(() => null);
  clientPromise = null;
  if (client) {
    await client.close();
  }
}
