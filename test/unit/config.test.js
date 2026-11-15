import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, describeConfig } from "../../server/lib/config.js";
import { ensureWriteAuthorizerKey } from "../../server/lib/write-grant.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sandboxRoot = path.join(path.dirname(projectRoot), `.bridge-config-test-${process.pid}`);

const ENV_KEYS = [
  "DSH_BRIDGE_CONFIG",
  "DSH_BRIDGE_ALLOWED_ROOTS",
  "DSH_BRIDGE_DSH_CLI",
  "DSH_BRIDGE_WRITE_KEY_FILE",
  "DSH_BRIDGE_WRITE_GRANT_FILE",
  "DSH_BRIDGE_RUNTIME_STATUS_FILE",
  "DSH_CLI_PATH",
  "DSH_CLI",
  "DSH_HOME"
];

function saveEnv() {
  return new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
}

function restoreEnv(previous) {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test("loads config, distinguishes enabled from ready, and never exposes secrets", async () => {
  await mkdir(sandboxRoot, { recursive: true });
  const configPath = path.join(sandboxRoot, "bridge.config.json");
  const keyPath = path.join(sandboxRoot, "write-authorizer.key");
  const grantPath = path.join(sandboxRoot, "write-grant.json");
  await writeFile(
    configPath,
    JSON.stringify({
      dshCliPath: "G:\\fake\\dsh.cmd",
      dshProfile: "headless",
      dshHome: path.join(sandboxRoot, "dsh-home"),
      allowedRoots: [sandboxRoot],
      writeModeEnabled: true,
      writeAuthorizerKeyFile: keyPath,
      writeGrantFile: grantPath,
      maxTasks: 3
    }),
    "utf8"
  );

  const previous = saveEnv();
  try {
    delete process.env.DSH_BRIDGE_DSH_CLI;
    delete process.env.DSH_CLI_PATH;
    delete process.env.DSH_CLI;
    process.env.DSH_BRIDGE_CONFIG = configPath;
    process.env.DSH_BRIDGE_ALLOWED_ROOTS = sandboxRoot;
    process.env.DSH_HOME = path.join(sandboxRoot, "dsh-home");

    const beforeKey = loadConfig();
    assert.equal(beforeKey.dsh.cliPath, "G:\\fake\\dsh.cmd");
    assert.equal(beforeKey.limits.maxTasks, 3);
    assert.equal(beforeKey.security.writeModeEnabled, true);
    assert.equal(beforeKey.security.writeReady, false);
    assert.equal(beforeKey.security.writeAuthorizerKeyPresent, false);
    assert.match(beforeKey.warnings.join("\n"), /authorizer key is missing/i);

    await ensureWriteAuthorizerKey(beforeKey);

    const afterKey = loadConfig();
    assert.equal(afterKey.security.writeModeEnabled, true);
    assert.equal(afterKey.security.writeReady, true);
    assert.equal(afterKey.security.writeAuthorizerKeyPresent, true);
    assert.equal(afterKey.security.writeAuthorization, "local-grant");

    const publicConfig = describeConfig(afterKey);
    const serialized = JSON.stringify(publicConfig);
    assert.equal(publicConfig.write_mode_enabled, true);
    assert.equal(publicConfig.write_ready, true);
    assert.equal(publicConfig.write_authorization, "local-grant");
    assert.equal(publicConfig.write_authorizer_key_present, true);
    assert.doesNotMatch(serialized, /writeToken|write_token|signature|nonce/);
  } finally {
    restoreEnv(previous);
    await rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("reports write mode enabled but not ready when the authorizer key is absent", async () => {
  await mkdir(sandboxRoot, { recursive: true });
  const configPath = path.join(sandboxRoot, "bridge-no-key.json");
  await writeFile(
    configPath,
    JSON.stringify({
      writeModeEnabled: true,
      writeAuthorizerKeyFile: path.join(sandboxRoot, "missing-key"),
      writeGrantFile: path.join(sandboxRoot, "missing-grant.json"),
      allowedRoots: []
    }),
    "utf8"
  );

  const previous = saveEnv();
  try {
    delete process.env.DSH_BRIDGE_ALLOWED_ROOTS;
    process.env.DSH_HOME = path.join(sandboxRoot, "dsh-home");
    const config = loadConfig({ configPathOverride: configPath });
    assert.equal(config.security.writeModeEnabled, true);
    assert.equal(config.security.writeReady, false);
    assert.equal(config.security.writeToken, undefined);
    assert.match(config.warnings.join("\n"), /authorizer key is missing/i);
  } finally {
    restoreEnv(previous);
    await rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
  }
});
