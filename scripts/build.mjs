import { readFileSync } from "node:fs"
import { build } from "esbuild"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

await build({
  entryPoints: ["src/hw-memory.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  external: ["bun:sqlite", "node:*"],
  outfile: "plugin/hw-memory.ts",
  banner: { js: `// hw-memory v${pkg.version}` },
})

console.log(`bundled plugin/hw-memory.ts (v${pkg.version})`)
