/**
 * Database error classification and availability handling.
 * Identifies database connectivity, shutdown, timeout, and pool exhaustion errors
 * to emit controlled 503 Service Unavailable responses instead of silent in-memory fallbacks.
 */

const DB_UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "53300", // too_many_connections
]);

const DB_UNAVAILABLE_PHRASES = [
  "connection terminated",
  "connection lost",
  "connect econnrefused",
  "client has been closed",
  "timeout exceeded when trying to connect",
  "terminating connection due to administrator command",
  "server closed the connection unexpectedly",
  "database service is currently unavailable",
  "cannot establish connection",
  "failed to connect to postgresql",
  "pool is closed",
];

export function isDatabaseUnavailableError(err: any): boolean {
  if (!err) return false;

  const code = err.code || err.cause?.code;
  if (code && DB_UNAVAILABLE_CODES.has(String(code))) {
    return true;
  }

  const message = String(err.message || "").toLowerCase();
  return DB_UNAVAILABLE_PHRASES.some((phrase) => message.includes(phrase));
}

export function createDatabaseUnavailableResponse() {
  return {
    message: "Database service is temporarily unavailable. Please try again shortly.",
    code: "DATABASE_UNAVAILABLE",
    status: 503,
  };
}
