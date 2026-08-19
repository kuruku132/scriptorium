import { App, FuzzySuggestModal, TFile } from "obsidian";

export class JsonFileModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly choose: (file: TFile) => void
  ) {
    super(app);
    this.setPlaceholder("가져올 RisuAI 로어북 JSON을 선택하세요");
  }

  getItems(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((file) => file.extension === "json")
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.choose(file);
  }
}