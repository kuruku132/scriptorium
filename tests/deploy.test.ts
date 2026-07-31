import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deployArtifacts } from "../scripts/deploy.mjs";

describe("local deployment", () => {
  it("copies only build artifacts and preserves plugin data", async () => {
    const root = await mkdtemp(join(tmpdir(), "scriptorium-deploy-"));
    const source = join(root, "dist");
    const target = join(root, "plugin");
    await mkdir(source);
    await mkdir(target);
    for (const artifact of ["main.js", "manifest.json", "styles.css"]) {
      await writeFile(join(source, artifact), artifact, "utf8");
    }
    await writeFile(join(target, "data.json"), "user-data", "utf8");
    await mkdir(join(target, "cache"));
    await writeFile(join(target, "cache", "state"), "keep", "utf8");
    const configPath = join(root, "deploy.local.json");
    await writeFile(configPath, JSON.stringify({ target }), "utf8");

    await deployArtifacts({ source, configPath });

    expect(await readFile(join(target, "main.js"), "utf8")).toBe("main.js");
    expect(await readFile(join(target, "data.json"), "utf8")).toBe(
      "user-data"
    );
    expect(await readFile(join(target, "cache", "state"), "utf8")).toBe(
      "keep"
    );
  });
});
