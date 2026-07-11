import { MongoClient } from "mongodb";
import { loadConfig } from "../config.js";
// Bounds how long a connection attempt can take before the driver gives up.
// The hooks that call getDb() (userPromptSubmit, sessionStart, sessionEnd)
// race their work against internal fail-open budgets (SESSION_START_TIMEOUT_MS
// for the SessionStart brief fetch, HOOK_WRITE_TIMEOUT_MS for the hash-line
// capture write, SESSION_END_TIMEOUT_MS for the transcript capture) so a
// memory system outage never stalls the user's coding session. If the
// driver's default 30000ms timeout were left in place, closeDb() (called from
// every hook's finally block) would still block on the original connect()
// promise long after those races had already timed out. 5000ms is comfortably
// longer than a normal Atlas round trip but far shorter than the default,
// so the worst case is a few seconds, not thirty.
const SERVER_SELECTION_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 5000;
// serverSelectionTimeoutMS and connectTimeoutMS only bound the driver's
// Topology/socket phases. For a mongodb+srv:// URI (the standard Atlas
// connection string format), the driver first resolves SRV/TXT DNS records
// via plain dns.promises calls, before the Topology object that owns
// serverSelectionTimeoutMS is even created. That DNS step has no
// configurable timeout, so if the resolver itself is unreachable (VPN down,
// firewall dropping DNS, no route), connect() can hang indefinitely even
// with the options above in place. This constant is a hard wall-clock cap
// on the whole connect() attempt, independent of which phase (DNS lookup,
// socket connect, or server selection) is the one stuck, so closeDb()'s
// await on clientPromise is always bounded.
const CONNECT_ATTEMPT_TIMEOUT_MS = 5000;
let clientPromise = null;
/**
 * Races a MongoClient's connect() against a hard wall-clock timeout so a
 * stuck DNS lookup, socket connect, or server selection can never leave the
 * returned promise pending past CONNECT_ATTEMPT_TIMEOUT_MS. If the real
 * connect() eventually settles after we have already given up and rejected,
 * and it resolved successfully, we close the now-unwanted client instead of
 * leaking the connection.
 */
function connectWithHardTimeout(client) {
    return new Promise((resolve, reject) => {
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`MongoDB connect() exceeded the ${CONNECT_ATTEMPT_TIMEOUT_MS}ms hard timeout (this bound covers DNS SRV/TXT resolution for mongodb+srv:// URIs too, not just server selection)`));
        }, CONNECT_ATTEMPT_TIMEOUT_MS);
        timer.unref();
        client.connect().then((connected) => {
            clearTimeout(timer);
            if (timedOut) {
                void connected.close().catch(() => { });
                return;
            }
            resolve(connected);
        }, (err) => {
            clearTimeout(timer);
            if (!timedOut)
                reject(err);
        });
    });
}
/**
 * Returns a lazily-connected, reused Db handle. Never logs the connection
 * string; connection errors are rethrown as a generic message since the
 * original error may embed the URI.
 */
export async function getDb() {
    const config = loadConfig();
    if (!clientPromise) {
        const client = new MongoClient(config.mongodbUri, {
            serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
            connectTimeoutMS: CONNECT_TIMEOUT_MS,
        });
        clientPromise = connectWithHardTimeout(client).catch((err) => {
            clientPromise = null;
            throw new Error(`Failed to connect to MongoDB (see original error for details, redacted here): ${err instanceof Error ? err.name : "unknown error"}`);
        });
    }
    const client = await clientPromise;
    return client.db(config.mongodbDb);
}
export async function closeDb() {
    if (!clientPromise)
        return;
    const client = await clientPromise.catch(() => null);
    clientPromise = null;
    if (client) {
        await client.close();
    }
}
