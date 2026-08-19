import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deployArtifacts } from "../scripts/deploy.mjs";
import { verifyArtifacts } from "../scripts/finalize.mjs";

describe("local deployment", () => {
  it("copies only build artifacts and preserves plugin data", async () => {
    const root = await mkdtemp(join(tmpdir(), "scriptorium-deploy-"));
    const source = join(root, "dist");
    const target = join(root, "plugin");
    await mkdir(source);
    await mkdir(target);
    for (const artifact of ["main.js", "styles.css"]) {
      await writeFile(join(source, artifact), artifact, "utf8");
    }
    // deploy.mjs가 manifest.json을 JSON으로 파싱하므로 유효한 JSON을 작성한다.
    await writeFile(
      join(source, "manifest.json"),
      JSON.stringify({
        id: "scriptorium",
        name: "Scriptorium",
        version: "2.1.0",
        description: "test build"
      }),
      "utf8"
    );
    await writeFile(join(target, "data.json"), "user-data", "utf8");
    await mkdir(join(target, "cache"));
    await writeFile(join(target, "cache", "state"), "keep", "utf8");
    const configPath = join(root, "deploy.local.json");
    await writeFile(configPath, JSON.stringify({ target }), "utf8");

    const deployedTarget = await deployArtifacts({ source, configPath });
    const hashes = await verifyArtifacts(source, deployedTarget);

    // main.js는 복사 전 source에 배너가 찍히므로 target에도 배너가 포함된다.
    const mainJs = await readFile(join(target, "main.js"), "utf8");
    expect(mainJs).toMatch(/^\/\*!\n \* Scriptorium v2\.1\.0 — test build/);
    expect(mainJs).toMatch(/main\.js$/);
    // manifest.json과 styles.css는 내용이 그대로 복사된다.
    expect(await readFile(join(target, "manifest.json"), "utf8")).toBe(
      JSON.stringify({
        id: "scriptorium",
        name: "Scriptorium",
        version: "2.1.0",
        description: "test build"
      })
    );
    expect(await readFile(join(target, "styles.css"), "utf8")).toBe("styles.css");
    expect(
      hashes.map((entry: { artifact: string }) => entry.artifact)
    ).toEqual([
      "main.js",
      "manifest.json",
      "styles.css"
    ]);
    expect(await readFile(join(target, "data.json"), "utf8")).toBe(
      "user-data"
    );
    expect(await readFile(join(target, "cache", "state"), "utf8")).toBe(
      "keep"
    );
  });
});
