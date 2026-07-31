import type { App } from "obsidian";
import { describe, expect, it } from "vitest";
import {
  createProject,
  migrateRuntimeData
} from "../src/modules/project";
import { TFile } from "./obsidian-stub";

describe("project registration", () => {
  it("rejects overlapping and nested roots", () => {
    const first = createProject("world", []);
    expect(() => createProject("world/characters", [first])).toThrow(/겹치거나/);
    expect(() => createProject("world", [first])).toThrow(/겹치거나/);
    expect(() => createProject("other", [first])).not.toThrow();
  });
});

describe("v1 migration", () => {
  it("imports real directory workspaces and converts ignore rules to frontmatter", async () => {
    const contents = new Map([
      ["alpha/prompt.md", "Alpha prompt"],
      ["beta/prompt.md", "Beta prompt"],
      ["alpha/risuignore.md", "- private/**\n# comment"],
      ["alpha/private/secret.md", "Secret"],
      ["alpha/public.md", "Public"]
    ]);
    const files = new Map(
      [...contents.keys()].map((path) => [path, new TFile(path)])
    );
    const app = {
      vault: {
        getAbstractFileByPath(path: string) {
          return files.get(path) ?? null;
        },
        async cachedRead(file: TFile) {
          return contents.get(file.path) ?? "";
        },
        getMarkdownFiles() {
          return [...files.values()].filter(
            (file) => file.extension === "md"
          );
        },
        async modify(file: TFile, content: string) {
          contents.set(file.path, content);
        }
      }
    } as unknown as App;

    const migrated = await migrateRuntimeData(
      app,
      {
        workspaces: [{ directory: "alpha" }, { directory: "beta" }],
        openaiCompatibleApiUrl: "https://example.com/v1",
        openaiCompatibleModel: "example-model"
      },
      "alpha/note.md"
    );

    expect(migrated.settings.projects.map((project) => project.root)).toEqual([
      "alpha",
      "beta"
    ]);
    expect(migrated.settings.projects[0]?.translationPrompt).toBe(
      "Alpha prompt"
    );
    expect(migrated.settings.projects[1]?.translationPrompt).toBe(
      "Beta prompt"
    );
    expect(migrated.settings.projects[0]?.excludeGlobs).not.toContain(
      "private/**"
    );
    expect(contents.get("alpha/private/secret.md")).toContain(
      "scriptorium: false"
    );
    expect(contents.get("alpha/public.md")).toBe("Public");
    expect(migrated.settings.api).toMatchObject({
      baseUrl: "https://example.com/v1",
      model: "example-model"
    });
  });

  it("upgrades v2 project globs once and keeps current project identity", async () => {
    const secret = new TFile("alpha/private/secret.md");
    const contents = new Map([[secret.path, "Secret"]]);
    const app = {
      vault: {
        getMarkdownFiles() {
          return [secret];
        },
        async cachedRead(file: TFile) {
          return contents.get(file.path) ?? "";
        },
        async modify(file: TFile, content: string) {
          contents.set(file.path, content);
        }
      }
    } as unknown as App;
    const migrated = await migrateRuntimeData(
      app,
      {
        settings: {
          version: 2,
          projects: [
            {
              id: "project-alpha",
              name: "Alpha",
              root: "alpha",
              syncMode: "original",
              excludeGlobs: ["private/**"]
            }
          ]
        },
        caches: {}
      },
      null
    );
    expect(migrated.settings.version).toBe(3);
    expect(migrated.settings.projects[0]).toMatchObject({
      id: "project-alpha",
      name: "Alpha",
      syncMode: "original",
      includeFolderEntries: true,
      translationPrompt: ""
    });
    expect(migrated.settings.projects[0]?.excludeGlobs).not.toContain(
      "private/**"
    );
    expect(contents.get(secret.path)).toContain("scriptorium: false");
  });
});
