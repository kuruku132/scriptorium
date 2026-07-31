# Scriptorium RisuAI plugin

`scriptorium.js`는 Scriptorium 2.0의 스냅샷 API를 RisuAI 캐릭터 로어북에
연결하는 RisuAI JavaScript 플러그인입니다.

## 로컬 연결

1. Obsidian Scriptorium 설정에서 로컬 서버를 켭니다.
2. RisuAI에 `scriptorium.js`를 JavaScript 플러그인으로 가져옵니다.
3. 기본값인 `127.0.0.1:27124`를 그대로 쓰거나 양쪽의 포트를 같게 맞춥니다.
4. Obsidian에서 대상 프로젝트 안의 문서를 엽니다.
5. RisuAI 채팅의 **스크립토리움** 버튼을 열고 **현재 프로젝트 연결**을
   눌러 현재 캐릭터와 프로젝트를 연결합니다.

## 릴레이 연결

Obsidian과 RisuAI 양쪽에 같은 Worker URL, 채널, 토큰을 설정합니다. RisuAI
플러그인에서 Worker URL을 입력하면 로컬 서버 대신 다음 주소를 폴링합니다.

```text
{workerUrl}/v1/channels/{channel}/snapshot
```

토큰을 쓰는 Worker라면 양쪽에 같은 Bearer 토큰을 입력해야 합니다.

## 동작

- `If-None-Match`와 `ETag`으로 변경된 스냅샷만 다시 읽습니다.
- `status: "ready"`인 schema 1 스냅샷만 캐릭터에 적용합니다.
- `status: "no-active-project"`이면 기존 로어북을 지우지 않고 대기합니다.
- 스냅샷의 `project.id`가 현재 캐릭터에 연결된 프로젝트와 같을 때만
  `globalLore`를 교체합니다.
- `Description으로 옮길 항목 이름`을 설정하면 해당 `comment`의 항목을
  캐릭터 description으로 옮기고 로어북에서는 제외합니다.
