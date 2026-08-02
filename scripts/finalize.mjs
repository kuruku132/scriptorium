import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACTS, deployArtifacts } from "./deploy.mjs";

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: false
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      reject(
        new Error(
          signal
            ? `${command} 실행이 ${signal} 신호로 종료되었습니다.`
            : `${command} 실행이 종료 코드 ${code}로 실패했습니다.`
        )
      );
    });
  });
}

async function runNpmScript(name) {
  console.log(`\n[finalize] npm run ${name}`);
  if (process.env.npm_execpath) {
    await run(process.execPath, [process.env.npm_execpath, "run", name]);
    return;
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await run(npm, ["run", name]);
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function verifyArtifacts(source, target) {
  const hashes = [];
  for (const artifact of ARTIFACTS) {
    const sourceHash = await sha256(resolve(source, artifact));
    const targetHash = await sha256(resolve(target, artifact));
    if (sourceHash !== targetHash) {
      throw new Error(`배포 산출물 검증 실패: ${artifact}`);
    }
    hashes.push({ artifact, sha256: sourceHash });
  }
  return hashes;
}

export async function finalize() {
  await runNpmScript("typecheck");
  await runNpmScript("test");
  await runNpmScript("build");

  console.log("\n[finalize] Obsidian 플러그인 배포");
  const source = resolve("dist");
  const target = await deployArtifacts({ source });
  const hashes = await verifyArtifacts(source, target);

  console.log(`\n[finalize] 완료: ${target}`);
  for (const { artifact, sha256: hash } of hashes) {
    console.log(`  ${artifact}  ${hash}`);
  }
  return { target, hashes };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await finalize();
}
