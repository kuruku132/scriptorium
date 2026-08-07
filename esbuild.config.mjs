import esbuild from "esbuild";
import { cp, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");

await mkdir("dist", { recursive: true });

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "node:http", "node:https"],
  format: "cjs",
  platform: "node",
  target: "es2022",
  outfile: "dist/main.js",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  logLevel: "info"
});

await Promise.all([
  cp("manifest.json", "dist/manifest.json"),
  cp("styles.css", "dist/styles.css")
]);

if (watch) {
  await context.watch();
  console.log("Watching Scriptorium sources...");
} else {
  await context.rebuild();
  await context.dispose();
}
