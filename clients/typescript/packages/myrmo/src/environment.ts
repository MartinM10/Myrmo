// Coarse environment detection. Never includes hostnames, paths or environment variables.

import { existsSync, readFileSync } from "node:fs";
import { release } from "node:os";
import type { Environment, Package } from "./types.js";

const OS: Record<string, string> = { linux: "linux", darwin: "macos", win32: "windows", freebsd: "freebsd" };
const ARCH: Record<string, string> = { x64: "x86_64", arm64: "arm64", ia32: "x86", arm: "arm", riscv64: "riscv64" };

function container(): string {
  try {
    if (existsSync("/.dockerenv")) return "docker";
    if (process.env.KUBERNETES_SERVICE_HOST) return "kubernetes";
    if (release().toLowerCase().includes("microsoft")) return "wsl";
    if (existsSync("/proc/1/cgroup") && /docker|containerd|podman/.test(readFileSync("/proc/1/cgroup", "utf8"))) return "docker";
  } catch {
    // Detection is best effort.
  }
  return "none";
}

/** OS, architecture and container kind of this machine. */
export function detectEnvironment(): Environment {
  return {
    os: OS[process.platform] ?? "other",
    arch: ARCH[process.arch] ?? "other",
    container: container(),
  };
}

/** `"numpy@1.24.4"` → `{ name: "numpy", version: "1.24.4" }`. Scoped npm names keep their `@`. */
export function parsePackage(spec: string | Package): Package {
  if (typeof spec !== "string") return spec;
  const at = spec.lastIndexOf("@");
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec };
}
