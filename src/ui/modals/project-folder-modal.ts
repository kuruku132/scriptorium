import { App, FuzzySuggestModal, TFolder } from "obsidian";

export class ProjectFolderModal extends FuzzySuggestModal<TFolder> {
  constructor(
    app: App,
    private readonly choose: (folder: TFolder) => void
  ) {
    super(app);
    this.setPlaceholder("프로젝트 루트 폴더를 선택하세요");
  }

  getItems(): TFolder[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .filter((folder) => folder.path !== "/");
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.choose(folder);
  }
}