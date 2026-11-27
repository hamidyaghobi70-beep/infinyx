import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer, connect as connectTls } from "node:tls";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildPostgresPoolConfig,
  PostgresConfigurationError
} from "./postgres-pool.js";

const databaseUrl = "postgresql://infinyx_app:secret@example.test:5432/infinyx";

interface TestCertificates {
  readonly directory: string;
  readonly ca: string;
  readonly otherCa: string;
  readonly serverCertificate: string;
  readonly serverKey: string;
  readonly expiredCertificate: string;
  readonly expiredKey: string;
}

let certificates: TestCertificates;

function generateTestCertificates(): TestCertificates {
  const directory = mkdtempSync(join(tmpdir(), "infinyx-postgres-tls-"));
  const caKey = join(directory, "ca.key");
  const ca = join(directory, "ca.pem");
  const otherCaKey = join(directory, "other-ca.key");
  const otherCa = join(directory, "other-ca.pem");
  const serverKey = join(directory, "server.key");
  const serverCsr = join(directory, "server.csr");
  const serverCertificate = join(directory, "server.pem");
  const expiredKey = join(directory, "expired.key");
  const expiredCsr = join(directory, "expired.csr");
  const expiredCertificate = join(directory, "expired.pem");

  const run = (args: string[]) =>
    execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });

  run([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", caKey, "-out", ca, "-days", "3650",
    "-subj", "/CN=INFINYX Test CA",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign"
  ]);
  run([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", otherCaKey, "-out", otherCa, "-days", "3650",
    "-subj", "/CN=INFINYX Untrusted Test CA",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign"
  ]);

  run([
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", serverKey, "-out", serverCsr, "-subj", "/CN=localhost"
  ]);
  run([
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", expiredKey, "-out", expiredCsr, "-subj", "/CN=expired-localhost"
  ]);

  const extensions = join(directory, "server.ext");
  writeFileSync(
    extensions,
    "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\n"
  );
  run([
    "x509", "-req", "-in", serverCsr, "-CA", ca, "-CAkey", caKey,
    "-CAcreateserial", "-out", serverCertificate, "-days", "2",
    "-sha256", "-extfile", extensions, "-days", "3650"
  ]);

  writeFileSync(join(directory, "index.txt"), "");
  writeFileSync(join(directory, "serial"), "1000\n");
  writeFileSync(
    join(directory, "ca.cnf"),
    `[ ca ]
default_ca = CA_default
[ CA_default ]
dir = ${directory}
database = $dir/index.txt
new_certs_dir = $dir
certificate = $dir/ca.pem
private_key = $dir/ca.key
serial = $dir/serial
default_md = sha256
policy = policy_any
[ policy_any ]
commonName = supplied
[ server_ext ]
subjectAltName = DNS:localhost
extendedKeyUsage = serverAuth
keyUsage = digitalSignature,keyEncipherment
basicConstraints = CA:FALSE
`
  );
  run([
    "ca", "-batch", "-notext", "-config", join(directory, "ca.cnf"),
    "-extensions", "server_ext", "-in", expiredCsr, "-out", expiredCertificate,
    "-startdate", "20200101000000Z", "-enddate", "20210101000000Z"
  ]);

  return {
    directory,
    ca: readFileSync(ca, "utf8"),
    otherCa: readFileSync(otherCa, "utf8"),
    serverCertificate: readFileSync(serverCertificate, "utf8"),
    serverKey: readFileSync(serverKey, "utf8"),
    expiredCertificate: readFileSync(expiredCertificate, "utf8"),
    expiredKey: readFileSync(expiredKey, "utf8")
  };
}

async function tlsHandshake(options: {
  readonly ca: string;
  readonly servername: string;
  readonly certificate: string;
  readonly key: string;
}): Promise<void> {
  const server = createTlsServer(
    { cert: options.certificate, key: options.key },
    (socket) => socket.end()
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  try {
    await new Promise<void>((resolve, reject) => {
      const socket = connectTls({
        host: "127.0.0.1",
        port: address.port,
        servername: options.servername,
        ca: options.ca,
        rejectUnauthorized: true
      });
      socket.once("secureConnect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", reject);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

beforeAll(() => {
  certificates = generateTestCertificates();
});

afterAll(() => {
  if (certificates?.directory) {
    rmSync(certificates.directory, { recursive: true, force: true });
  }
});

describe("buildPostgresPoolConfig", () => {
  const strictTlsEnvironment = () => ({
    DATABASE_URL: databaseUrl,
    DATABASE_SSL_CA: certificates.ca,
    DATABASE_SSL_SERVERNAME: "example.test"
  });

  it("requires a PostgreSQL connection URL", () => {
    expect(() => buildPostgresPoolConfig({})).toThrow(
      PostgresConfigurationError
    );
    expect(() =>
      buildPostgresPoolConfig({ DATABASE_URL: "https://example.test/db" })
    ).toThrow(PostgresConfigurationError);
  });

  it("requires an explicit CA and DNS server identity by default", () => {
    expect(() => buildPostgresPoolConfig({ DATABASE_URL: databaseUrl })).toThrow(
      PostgresConfigurationError
    );
    const config = buildPostgresPoolConfig(strictTlsEnvironment());
    expect(config.ssl).toEqual({
      rejectUnauthorized: true,
      ca: certificates.ca,
      servername: "example.test"
    });
    expect(config.application_name).toBe("infinyx-api");
  });

  it.each([
    "sslmode=disable",
    "sslmode=require",
    "sslrootcert=%2Ftmp%2Froot.crt",
    "sslcert=%2Ftmp%2Fclient.crt",
    "sslkey=%2Ftmp%2Fclient.key",
    "SSLMode=disable"
  ])("rejects SSL policy parameters in DATABASE_URL (%s)", (parameter) => {
    expect(() =>
      buildPostgresPoolConfig({
        ...strictTlsEnvironment(),
        DATABASE_URL: `${databaseUrl}?${parameter}`
      })
    ).toThrow(PostgresConfigurationError);
  });

  it("rejects a non-CA certificate as the configured trust anchor", () => {
    expect(() =>
      buildPostgresPoolConfig({
        ...strictTlsEnvironment(),
        DATABASE_SSL_CA: certificates.serverCertificate
      })
    ).toThrow(PostgresConfigurationError);
  });

  it("requires a DNS name, not an IP literal, for TLS server identity", () => {
    expect(() =>
      buildPostgresPoolConfig({
        ...strictTlsEnvironment(),
        DATABASE_SSL_SERVERNAME: "127.0.0.1"
      })
    ).toThrow(PostgresConfigurationError);
    expect(() =>
      buildPostgresPoolConfig({
        ...strictTlsEnvironment(),
        DATABASE_SSL_SERVERNAME: "bad name"
      })
    ).toThrow(PostgresConfigurationError);
  });

  it("rejects a DNS TLS identity that differs from a DNS database host", () => {
    expect(() =>
      buildPostgresPoolConfig({
        ...strictTlsEnvironment(),
        DATABASE_SSL_SERVERNAME: "another.example.test"
      })
    ).toThrow(PostgresConfigurationError);
  });

  it("allows TLS opt-out only in tests or local development", () => {
    expect(
      buildPostgresPoolConfig({
        DATABASE_URL: databaseUrl,
        DATABASE_SSL: "disable",
        NODE_ENV: "test"
      }).ssl
    ).toBe(false);
    expect(
      buildPostgresPoolConfig({
        DATABASE_URL: "postgresql://infinyx_app:secret@localhost:5432/infinyx",
        DATABASE_SSL: "disable",
        NODE_ENV: "development"
      }).ssl
    ).toBe(false);
    expect(() =>
      buildPostgresPoolConfig({
        DATABASE_URL: databaseUrl,
        DATABASE_SSL: "disable",
        NODE_ENV: "development"
      })
    ).toThrow(PostgresConfigurationError);
    expect(() =>
      buildPostgresPoolConfig({
        DATABASE_URL: databaseUrl,
        DATABASE_SSL: "disable",
        NODE_ENV: "production"
      })
    ).toThrow(PostgresConfigurationError);
    expect(() =>
      buildPostgresPoolConfig({
        DATABASE_URL: databaseUrl,
        DATABASE_SSL: "disable",
        NODE_ENV: ""
      })
    ).toThrow(PostgresConfigurationError);
  });

  it("uses bounded pool and timeout defaults", () => {
    const config = buildPostgresPoolConfig(strictTlsEnvironment());
    expect(config.max).toBe(5);
    expect(config.connectionTimeoutMillis).toBe(5000);
    expect(config.idleTimeoutMillis).toBe(10000);
    expect(config.statement_timeout).toBe(10000);
  });

  it("accepts safe overrides within documented limits", () => {
    const config = buildPostgresPoolConfig({
      ...strictTlsEnvironment(),
      DATABASE_POOL_MAX: "12",
      DATABASE_CONNECTION_TIMEOUT_MS: "8000",
      DATABASE_IDLE_TIMEOUT_MS: "20000",
      DATABASE_STATEMENT_TIMEOUT_MS: "15000"
    });
    expect(config.max).toBe(12);
    expect(config.connectionTimeoutMillis).toBe(8000);
    expect(config.idleTimeoutMillis).toBe(20000);
    expect(config.statement_timeout).toBe(15000);
  });

  it.each([
    ["DATABASE_POOL_MAX", "0"],
    ["DATABASE_POOL_MAX", "21"],
    ["DATABASE_CONNECTION_TIMEOUT_MS", "999"],
    ["DATABASE_IDLE_TIMEOUT_MS", "60001"],
    ["DATABASE_STATEMENT_TIMEOUT_MS", "not-a-number"],
    ["DATABASE_SSL", "prefer"]
  ])("rejects unsafe %s=%s configuration", (key, value) => {
    expect(() =>
      buildPostgresPoolConfig({
        ...strictTlsEnvironment(),
        [key]: value
      })
    ).toThrow(PostgresConfigurationError);
  });

  it("does not include connection credentials in configuration errors", () => {
    let thrown: unknown;
    try {
      buildPostgresPoolConfig({
        DATABASE_URL: "postgresql://secret:password@/",
        DATABASE_POOL_MAX: "999"
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PostgresConfigurationError);
    expect((thrown as Error).message).not.toContain("secret");
    expect((thrown as Error).message).not.toContain("password");
  });
});

describe("PostgreSQL TLS certificate verification", () => {
  it("accepts a trusted certificate with the matching DNS SAN", async () => {
    await expect(
      tlsHandshake({
        ca: certificates.ca,
        servername: "localhost",
        certificate: certificates.serverCertificate,
        key: certificates.serverKey
      })
    ).resolves.toBeUndefined();
  });

  it("rejects a certificate signed by an untrusted CA", async () => {
    await expect(
      tlsHandshake({
        ca: certificates.otherCa,
        servername: "localhost",
        certificate: certificates.serverCertificate,
        key: certificates.serverKey
      })
    ).rejects.toBeDefined();
  });

  it("rejects a hostname that does not match the certificate SAN", async () => {
    await expect(
      tlsHandshake({
        ca: certificates.ca,
        servername: "database.example.test",
        certificate: certificates.serverCertificate,
        key: certificates.serverKey
      })
    ).rejects.toBeDefined();
  });

  it("rejects an expired server certificate", async () => {
    await expect(
      tlsHandshake({
        ca: certificates.ca,
        servername: "localhost",
        certificate: certificates.expiredCertificate,
        key: certificates.expiredKey
      })
    ).rejects.toBeDefined();
  });
});
