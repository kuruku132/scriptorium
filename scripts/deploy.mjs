import { cp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ARTIFACTS = ["main.js", "manifest.json", "styles.css"];

export const REPO_URL = "https://github.com/kuruku132/scriptorium";

/**
 * main.js 맨 위에 repo 링크 배너 주석을 붙인다.
 * 이미 배너가 있거나 파일이 없으면 그대로 둔다.
 */
export async function stampRepoBanner(filePath, manifest) {
  let source = await readFile(filePath, "utf8");
  const banner = `/*!\n * Scriptorium v${manifest.version} — ${manifest.description}\n * Repo: ${REPO_URL}\n * Built: ${new Date().toISOString()}\n */\n`;
  // 기존 배너 주석이 있으면 교체, 없으면 앞에 붙임
  const bannerRe = /^\/\*![\s\S]*?\*\/\n/;
  source = bannerRe.test(source)
    ? source.replace(bannerRe, banner)
    : banner + source;
  await writeFile(filePath, source, "utf8");
}

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

  const manifest = JSON.parse(
    await readFile(resolve(source, "manifest.json"), "utf8")
  );

  for (const artifact of ARTIFACTS) {
    const from = resolve(source, artifact);
    await stat(from);
    await cp(from, resolve(target, artifact));
  }

  // 배포된 main.js 맨 위에 repo 링크 배너 주석 부착
  await stampRepoBanner(resolve(target, "main.js"), manifest);

  return target;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const target = await deployArtifacts();
  console.log(`Deployed Scriptorium build artifacts to ${target}`);
}
