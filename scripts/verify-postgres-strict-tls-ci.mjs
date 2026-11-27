import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { buildPostgresPoolConfig } from "../dist/persistence/postgres-pool.js";

const databaseUrl = process.env.TLS_TEST_DATABASE_URL;
const caFile = process.env.TLS_TEST_CA_FILE;
const wrongCaFile = process.env.TLS_TEST_WRONG_CA_FILE;

if (!databaseUrl || !caFile || !wrongCaFile) {
  throw new Error("PostgreSQL TLS CI fixture configuration is incomplete.");
}

const trustedCa = readFileSync(caFile, "utf8");
const untrustedCa = readFileSync(wrongCaFile, "utf8");

function poolFor(overrides = {}) {
  const config = buildPostgresPoolConfig({
    DATABASE_URL: databaseUrl,
    DATABASE_SSL: "require",
    DATABASE_SSL_CA: trustedCa,
    DATABASE_SSL_SERVERNAME: "localhost",
    NODE_ENV: "test",
    ...overrides
  });
  return new Pool(config);
}

async function expectConnectionRejected(label, pool) {
  let rejected = false;
  try {
    await pool.query("SELECT 1");
  } catch {
    rejected = true;
  } finally {
    await pool.end();
  }
  if (!rejected) {
    throw new Error(`PostgreSQL TLS verification did not reject: ${label}`);
  }
  console.log(`PASS: rejected ${label}`);
}

const trustedPool = poolFor();
try {
  const result = await trustedPool.query(
    "SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()"
  );
  if (result.rows.length !== 1 || result.rows[0].ssl !== true) {
    throw new Error("PostgreSQL connection did not use TLS.");
  }
  console.log("PASS: pg connected to PostgreSQL with verified TLS");
} finally {
  await trustedPool.end();
}

await expectConnectionRejected(
  "an untrusted certificate authority",
  poolFor({ DATABASE_SSL_CA: untrustedCa })
);

await expectConnectionRejected(
  "a hostname that does not match the certificate SAN",
  poolFor({
    DATABASE_URL: databaseUrl.replace("localhost", "127.0.0.1"),
    DATABASE_SSL_SERVERNAME: "not-localhost.example.test"
  })
);

const plaintextPool = new Pool(
  buildPostgresPoolConfig({
    DATABASE_URL: databaseUrl,
    DATABASE_SSL: "disable",
    NODE_ENV: "test"
  })
);
await expectConnectionRejected("plaintext PostgreSQL access", plaintextPool);
