import { cp, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ARTIFACTS = ["main.js", "manifest.json", "styles.css"];

export async function deployArtifacts({
  source = resolve("dist"),
  configPath = resolve("deploy.local.json")
} = {}) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (typeof config.target !== "string" || config.target.trim() === "") {
    throw new Error("deploy.local.json에 target 경로가 필요합니다.");
  }

  const target = isAbsolute(config.target)
    ? config.target
    : resolve(dirname(configPath), config.target);
  await mkdir(target, { recursive: true });

  for (const artifact of ARTIFACTS) {
    const from = resolve(source, artifact);
    await stat(from);
    await cp(from, resolve(target, artifact));
  }

  return target;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const target = await deployArtifacts();
  console.log(`Deployed Scriptorium build artifacts to ${target}`);
}
