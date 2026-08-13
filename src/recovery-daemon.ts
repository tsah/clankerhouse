#!/usr/bin/env bun
import { RecoveryController } from "./recovery/controller"

const once = process.argv.includes("--once")
const controller = new RecoveryController()

const stop = () => controller.stop()
process.on("SIGINT", stop)
process.on("SIGTERM", stop)

try {
  await controller.run({ once })
} finally {
  controller.close()
}
