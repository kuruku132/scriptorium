# Scriptorium 2.0

RisuAI 로어북을 Markdown으로 관리하고 문단 단위로 부분 번역하는 Obsidian
플러그인입니다. 프로젝트 문서를 열면 오른쪽 대시보드가 해당 프로젝트를
따라가며, 원문 또는 마지막 성공 번역본을 메모리에서 즉시 컴파일합니다.

## 개발

```sh
npm install
npm test
npm run typecheck
npm run check:risu
npm run build
```

빌드 결과는 `dist/main.js`, `dist/manifest.json`, `dist/styles.css`입니다.
`deploy.local.example.json`을 `deploy.local.json`으로 복사하고 실제 플러그인
경로를 입력한 다음 `npm run deploy`를 실행하면 이 세 파일만 복사합니다.
`data.json`이나 플러그인 내부 캐시는 건드리지 않습니다.

최소 Obsidian 버전은 1.11.4입니다. API 키와 릴레이 토큰은 Obsidian
SecretStorage에 저장하며 Scriptorium의 `data.json`에는 선택한 비밀값의
이름만 기록됩니다.

최종 검증과 로컬 배포는 `npm run finalize` 한 번으로 실행합니다. 타입 검사,
테스트, 빌드, Obsidian 플러그인 폴더 배포와 산출물 해시 검증을 순서대로
수행합니다.

## 프로젝트

명령 팔레트의 `Scriptorium: 프로젝트 등록`으로 정확한 루트 폴더를
등록합니다. 프로젝트 루트에는 원문 Markdown, `translate/`, 사용자가 직접
내보낸 `risu_lorebook.json`만 필요합니다. 프롬프트, 선택 상태, 문단 캐시는
플러그인 데이터에 저장됩니다.

프로젝트 이름, 원문/번역 동기화 모드, 프로젝트별 번역 프롬프트와 어휘 사전은
대시보드의 `프로젝트 설정`에서 관리하며 변경하면 자동 저장 알림과 함께
반영됩니다. 문서 제외 규칙은 glob 문자열을
사용하지 않습니다. 같은 패널의 문서 목록에서 체크를 끄면 해당 Markdown
frontmatter에 `scriptorium: false`가 기록됩니다.

어휘 사전은 한 줄에 `원문 = 번역어` 형식으로 작성합니다. 번역을 나눈 각
요청마다 원문·문맥·직전 번역에 어느 한쪽 표현이 나타난 항목만 전달됩니다.
같은 파일의 직전 번역과 인접한 기존 번역도 읽기 전용 문맥으로 전달하여
조각 사이의 용어와 호칭을 일관되게 유지합니다.

대시보드의 `고급 도구`에서는 RisuAI JSON 가져오기, 메타데이터
추가/교체/제거, 표 편집기 생성, 전체 Markdown 병합 문서 생성과 유지보수
작업을 실행할 수 있습니다. 도구 패널은 대시보드 아래에서 위로 열리며 패널
안에서 스크롤됩니다. 설정 화면의 접힌 `고급 설정`에는 API 프록시, 재시도와
제한 시간, 동시 번역 요청 수, 번역 중 중복 괄호 삭제 옵션이 있습니다.
병렬 요청의 결과는 같은 문서 안에서 원래 배치 순서대로 저장됩니다.

기존 데이터는 데이터 버전 3으로 처음 올라갈 때 한 번만 변환됩니다.
`directory` 기반 구형 워크스페이스, 프로젝트별 `prompt.md`, snake_case
로어북 메타데이터를 옮기며, `risuignore.md` 규칙은 해당 문서의
`scriptorium: false` frontmatter로 변환합니다.

사용자 명령은 다음 일곱 개입니다.

- `Scriptorium: 대시보드 열기`
- `Scriptorium: 프로젝트 등록`
- `Scriptorium: 번역 실행`
- `Scriptorium: JSON 내보내기`
- `Scriptorium: 릴레이에 지금 동기화`
- `Scriptorium: 작업 취소`
- `Scriptorium: 레거시 데이터 마이그레이션 실행`

## RisuAI에서 스냅샷 읽기

로컬 서버는 데스크톱에서만 사용할 수 있고 기본 주소는
`http://127.0.0.1:27124`입니다. RisuAI 클라이언트는 다음 전용 API를
사용합니다.

- `GET /v1/projects`: 등록된 프로젝트 목록
- `GET /v1/projects/{projectId}/manifest`: 문서 ID·경로·해시 목록
- `GET /v1/projects/{projectId}/documents/{documentId}`: 요청한 문서의
  로어북 항목

클라이언트는 manifest의 해시를 기존 캐시와 비교하고 추가·수정된 문서만
개별 요청합니다. 목록에서 사라진 문서는 캐시에서 삭제합니다. 최초 연결 때만
프로젝트의 모든 문서를 받고, 변경이 없으면 RisuAI의 `nativeFetch` 브리지와
호환되는 `200 + status: "not-modified"` 최소 응답이 반환됩니다. 기존
`/v1/snapshot`은 릴레이 및 이전 클라이언트 호환을 위해
유지합니다. 릴레이는 데스크톱과 모바일에서 모두 사용할 수 있습니다.

```js
let etag = "";

async function pollRelay(workerUrl, channel, token = "") {
  const response = await fetch(
    `${workerUrl}/v1/channels/${encodeURIComponent(channel)}/snapshot`,
    {
      headers: {
        ...(etag ? { "If-None-Match": etag } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }
  );
  if (response.status === 304) return null;
  etag = response.headers.get("ETag") ?? "";
  return response.json();
}
```

성공 응답은 `status: "ready"`와 Risu 로어북을 포함합니다. 활성 문서가
프로젝트 밖에 있으면 `status: "no-active-project"`가 전달됩니다.

RisuAI 클라이언트 플러그인은
[`risuai-plugin/scriptorium.js`](risuai-plugin/scriptorium.js)에 있습니다.
설치와 로컬/릴레이 연결 방법은
[`risuai-plugin/README.md`](risuai-plugin/README.md)를 참고하세요. 클라이언트는
로컬 연결에서는 등록된 프로젝트 목록 중 하나를 캐릭터마다 선택할 수 있으며,
활성 문서와 무관하게 연결한 `project.id`의 변경 문서만 요청합니다.

## 릴레이

Worker 소스와 수동 배포 절차는 [`relay/README.md`](relay/README.md)에
있습니다. 저장소는 Worker를 자동 배포하지 않습니다.

## DEBUG 로그

소스의 `DEBUG` 상수가 `true`이면 개발자 콘솔에 `[Scriptorium DEBUG ...]`
접두사로 서버 시작/종료, 모든 HTTP 요청과 응답 상태, manifest 컴파일 캐시
적중/무효화, 소요 시간이 기록됩니다. 기본값은 `false`입니다.
