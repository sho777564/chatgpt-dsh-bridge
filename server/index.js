#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, describeConfig } from "./lib/config.js";
import { createLogger } from "./lib/logger.js";
import { DshRunner } from "./lib/dsh-runner.js";
import { TaskManager } from "./lib/task-manager.js";
import { writeRuntimeStatus } from "./lib/runtime-status.js";
import { registerBridgeTools, BRIDGE_INSTRUCTIONS } from "./tools.js";

async function main() {
  const debug = /^(1|true|yes|on)$/i.test(process.env.DSH_BRIDGE_DEBUG || "");
  const logger = createLogger({ debug });
  const config = loadConfig();
  const runner = new DshRunner({ config, logger });
  const tasks = new TaskManager({ config, runner, logger });

  const server = new McpServer(
    {
      name: config.bridge.name,
      version: config.bridge.version
    },
    {
      instructions: BRIDGE_INSTRUCTIONS,
      capabilities: {
        logging: {}
      }
    }
  );

  registerBridgeTools(server, { config, runner, tasks, logger });

  logger.info("bridge_start", {
    version: config.bridge.version,
    config: describeConfig(config)
  });

  try {
    const status = await writeRuntimeStatus(config, { transport: "stdio" });
    logger.info("runtime_status_written", {
      pid: status.pid,
      write_mode_enabled: status.write_mode_enabled,
      write_ready: status.write_ready,
      write_grant_valid: status.write_grant?.valid === true,
      config_path: status.config_path
    });
  } catch (error) {
    logger.warn("runtime_status_write_failed", { message: error.message });
  }

  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 2 * 1024 * 1024
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("bridge_stop", { signal });
    try {
      await tasks.shutdown();
      await server.close();
    } catch (error) {
      logger.error("bridge_shutdown_error", { message: error.message });
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.stdin.once("end", () => void shutdown("stdin ended"));
  process.on("uncaughtException", (error) => {
    logger.error("uncaught_exception", { message: error.message, stack: error.stack?.slice(0, 2_000) });
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled_rejection", {
      message: reason instanceof Error ? reason.message : String(reason)
    });
  });

  await server.connect(transport);
  logger.info("bridge_ready", { transport: "stdio" });
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "bridge_fatal",
      message: error?.message || String(error),
      code: error?.code || "FATAL"
    })}\n`
  );
  process.exit(1);
});
