export class TAbstractFile {
  constructor(public path: string) {}
}

export class TFile extends TAbstractFile {
  basename: string;
  extension: string;

  constructor(path: string) {
    super(path);
    const name = path.split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");
    this.basename = dot < 0 ? name : name.slice(0, dot);
    this.extension = dot < 0 ? "" : name.slice(dot + 1);
  }
}

export class TFolder extends TAbstractFile {}

export class FileSystemAdapter {}

export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
}
