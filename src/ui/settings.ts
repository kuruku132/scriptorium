import {
  App,
  Platform,
  Plugin,
  PluginSettingTab,
  SecretComponent,
  Setting
} from "obsidian";
import type { ScriptoriumSettings } from "../shared/types";

export interface SettingsHost {
  settings: ScriptoriumSettings;
  saveSettings(): Promise<void>;
  refreshRuntimeSettings(): Promise<void>;
}

export class ScriptoriumSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly host: SettingsHost & Plugin
  ) {
    super(app, host);
  }

  private async changed(): Promise<void> {
    await this.host.saveSettings();
    await this.host.refreshRuntimeSettings();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Scriptorium" });

    containerEl.createEl("h3", { text: "번역" });
    new Setting(containerEl)
      .setName("공용 번역 프롬프트")
      .setDesc("모든 프로젝트 번역 요청의 system 메시지입니다.")
      .addTextArea((area) => {
        area.inputEl.rows = 8;
        area
          .setValue(this.host.settings.translationPrompt)
          .onChange(async (value) => {
            this.host.settings.translationPrompt = value;
            await this.host.saveSettings();
          });
      });
    new Setting(containerEl)
      .setName("OpenAI 호환 API 주소")
      .addText((text) =>
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.host.settings.api.baseUrl)
          .onChange(async (value) => {
            this.host.settings.api.baseUrl = value.trim();
            await this.host.saveSettings();
          })
      );
    new Setting(containerEl).setName("모델").addText((text) =>
      text.setValue(this.host.settings.api.model).onChange(async (value) => {
        this.host.settings.api.model = value.trim();
        await this.host.saveSettings();
      })
    );
    new Setting(containerEl)
      .setName("API 키")
      .setDesc("SecretStorage의 비밀값 이름만 data.json에 저장합니다.")
      .addComponent((element) =>
        new SecretComponent(this.app, element)
          .setValue(this.host.settings.api.secretName)
          .onChange(async (value) => {
            this.host.settings.api.secretName = value;
            await this.host.saveSettings();
          })
      );

    const advanced = containerEl.createEl("details", {
      cls: "scriptorium-settings-advanced"
    });
    advanced.createEl("summary", { text: "고급 설정" });
    new Setting(advanced)
      .setName("API 프록시 URL")
      .setDesc(
        "비워두면 API 주소로 직접 요청합니다. 사용 시 X-Target-URL 헤더로 실제 API 주소를 전달합니다."
      )
      .addText((text) =>
        text
          .setPlaceholder("https://proxy.example.com/v1/chat/completions")
          .setValue(this.host.settings.api.proxyUrl)
          .onChange(async (value) => {
            this.host.settings.api.proxyUrl = value.trim();
            await this.host.saveSettings();
          })
      );
    new Setting(advanced).setName("최대 요청 시도 횟수").addText((text) =>
      text
        .setValue(String(this.host.settings.api.maxRetries))
        .onChange(async (value) => {
          const number = Number(value);
          if (Number.isInteger(number) && number > 0) {
            this.host.settings.api.maxRetries = number;
            await this.host.saveSettings();
          }
        })
    );
    new Setting(advanced).setName("초기 재시도 대기 시간(초)").addText((text) =>
      text
        .setValue(String(this.host.settings.api.initialBackoffSeconds))
        .onChange(async (value) => {
          const number = Number(value);
          if (Number.isInteger(number) && number > 0) {
            this.host.settings.api.initialBackoffSeconds = number;
            await this.host.saveSettings();
          }
        })
    );
    new Setting(advanced).setName("요청 제한 시간(초)").addText((text) =>
      text
        .setValue(String(this.host.settings.api.requestTimeoutSeconds))
        .onChange(async (value) => {
          const number = Number(value);
          if (Number.isInteger(number) && number > 0) {
            this.host.settings.api.requestTimeoutSeconds = number;
            await this.host.saveSettings();
          }
        })
    );
    new Setting(advanced)
      .setName("중복 한국어 괄호 삭제")
      .setDesc(
        "번역 파일 안에서 같은 한국어 괄호 표현은 첫 번째만 남깁니다. 기본값은 꺼짐입니다."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(
            this.host.settings.advanced.deduplicateKoreanParentheses
          )
          .onChange(async (value) => {
            this.host.settings.advanced.deduplicateKoreanParentheses = value;
            await this.host.saveSettings();
          })
      );

    if (Platform.isDesktopApp) {
      containerEl.createEl("h3", { text: "로컬 서버" });
      new Setting(containerEl)
        .setName("로컬 스냅샷 서버")
        .setDesc("127.0.0.1에만 바인딩합니다.")
        .addToggle((toggle) =>
          toggle
            .setValue(this.host.settings.localServer.enabled)
            .onChange(async (value) => {
              this.host.settings.localServer.enabled = value;
              await this.changed();
            })
        );
      new Setting(containerEl).setName("포트").addText((text) =>
        text
          .setValue(String(this.host.settings.localServer.port))
          .onChange(async (value) => {
            const port = Number(value);
            if (Number.isInteger(port) && port > 0 && port <= 65_535) {
              this.host.settings.localServer.port = port;
              await this.changed();
            }
          })
      );
    }

    containerEl.createEl("h3", { text: "릴레이" });
    new Setting(containerEl).setName("릴레이 사용").addToggle((toggle) =>
      toggle
        .setValue(this.host.settings.relay.enabled)
        .onChange(async (value) => {
          this.host.settings.relay.enabled = value;
          await this.changed();
        })
    );
    new Setting(containerEl).setName("Worker 주소").addText((text) =>
      text
        .setPlaceholder("https://example.workers.dev")
        .setValue(this.host.settings.relay.baseUrl)
        .onChange(async (value) => {
          this.host.settings.relay.baseUrl = value.trim();
          await this.host.saveSettings();
        })
    );
    new Setting(containerEl).setName("채널").addText((text) =>
      text.setValue(this.host.settings.relay.channel).onChange(async (value) => {
        this.host.settings.relay.channel = value.trim();
        await this.host.saveSettings();
      })
    );
    new Setting(containerEl)
      .setName("릴레이 토큰")
      .setDesc("Worker가 인증을 요구할 때 사용할 SecretStorage 이름입니다.")
      .addComponent((element) =>
        new SecretComponent(this.app, element)
          .setValue(this.host.settings.relay.secretName)
          .onChange(async (value) => {
            this.host.settings.relay.secretName = value;
            await this.host.saveSettings();
          })
      );
    new Setting(containerEl).setName("자동 갱신").addToggle((toggle) =>
      toggle
        .setValue(this.host.settings.relay.autoPush)
        .onChange(async (value) => {
          this.host.settings.relay.autoPush = value;
          await this.host.saveSettings();
        })
    );

    if (this.host.settings.migrationWarnings.length > 0) {
      containerEl.createEl("h3", { text: "이행 경고" });
      const list = containerEl.createEl("ul");
      for (const warning of this.host.settings.migrationWarnings) {
        list.createEl("li", { text: warning });
      }
    }
  }
}
