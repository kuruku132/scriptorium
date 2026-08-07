# Scriptorium local relay

Obsidian 플러그인이 스냅샷을 올리고 RisuAI 플러그인이 가져가는 로컬 브로커
입니다. 과거의 Cloudflare Worker 릴레이를 대체하는 단일 Node.js 스크립트로,
별도의 빌드나 클라우드 계정 없이 `node relay/relay.mjs`로 바로 실행합니다.

## 실행

```sh
node relay/relay.mjs
```

기본 주소는 `http://127.0.0.1:27125`이고 스냅샷은 `relay/store.json`에
저장됩니다. 환경 변수로 다음을 바꿀 수 있습니다.

| 변수          | 기본값            | 설명                                            |
| ------------- | ----------------- | ----------------------------------------------- |
| `RELAY_HOST`  | `127.0.0.1`       | 바인딩 호스트                                   |
| `RELAY_PORT`  | `27125`           | 바인딩 포트                                     |
| `RELAY_TOKEN` | (없음)            | 설정하면 push와 pull 모두 `Authorization: Bearer …` 헤더 필요 |
| `RELAY_STORE` | `relay/store.json`| 스냅샷 저장 파일 경로                           |

`RELAY_TOKEN`을 비워두면 push와 pull 모두 무인증입니다. 같은 머신 안에서
쓸 때는 그대로 두고, 외부에서 접근해야 할 때만 토큰을 설정하세요.

## API

- `PUT /v1/channels/{channel}/snapshot` — 본문의 스냅샷을 채널에 저장합니다.
- `GET /v1/channels/{channel}/snapshot` — 채널의 최신 스냅샷을 반환합니다.
  `If-None-Match` 헤더로 조건부 요청하면 해시가 같을 때 `304`를 반환합니다.
- `OPTIONS` — CORS preflight.

채널 이름으로 여러 스냅샷을 독립적으로 보관할 수 있습니다. 예를 들어 여러
Obsidian 볼트가 각각 다른 채널에 올리거나 한 채널에 활성 프로젝트 스냅샷을
올려 RisuAI에서 가져가는 식으로 씁니다.

## 플러그인 설정

Obsidian Scriptorium 설정의 **릴레이** 항목과 RisuAI 플러그인의 릴레이 설정에
같은 주소·채널·(토큰)을 입력합니다. Obsidian이 활성 프로젝트를 컴파일해
릴레이에 PUT하고 RisuAI가 폴링하며 GET으로 받아 캐릭터 로어북에 반영합니다.