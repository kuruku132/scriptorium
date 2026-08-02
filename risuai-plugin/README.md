# Scriptorium RisuAI plugin

`scriptorium.js`는 Scriptorium 2.0의 스냅샷 API를 RisuAI 캐릭터 로어북에
연결하는 RisuAI JavaScript 플러그인입니다.

## 로컬 연결

1. Obsidian Scriptorium 설정에서 로컬 서버를 켭니다.
2. RisuAI에 `scriptorium.js`를 JavaScript 플러그인으로 가져옵니다.
3. 기본값인 `127.0.0.1:27124`를 그대로 쓰거나 양쪽의 포트를 같게 맞춥니다.
4. RisuAI 채팅의 **스크립토리움** 버튼을 열고 등록된 프로젝트를 선택합니다.
5. **선택 프로젝트 연결**을 눌러 현재 캐릭터와 프로젝트를 연결합니다.

## 릴레이 연결

Obsidian과 RisuAI 양쪽에 같은 Worker URL, 채널, 토큰을 설정합니다. RisuAI
플러그인에서 Worker URL을 입력하면 로컬 서버 대신 다음 주소를 폴링합니다.

```text
{workerUrl}/v1/channels/{channel}/snapshot
```

토큰을 쓰는 Worker라면 양쪽에 같은 Bearer 토큰을 입력해야 합니다.

## 동작

- 로컬 연결은 manifest에서 문서별 해시를 비교한 뒤 추가·수정된 문서만
  전용 문서 API로 요청하고, 삭제된 문서는 클라이언트 캐시에서 제거합니다.
- 변경이 없으면 revision만 포함한 `200 + status: "not-modified"` 최소 응답을
  사용합니다. RisuAI `nativeFetch` 브리지에서 304 역직렬화가 실패하는 문제를
  피하기 위해 304는 요청하지 않습니다.
- 설정한 폴링 간격마다 독립적으로 다음 확인을 시도합니다. 네트워크 및 RisuAI
  API 호출은 12초 뒤 중단되어 한 요청이 멈춰도 이후 폴링이 복구됩니다.
- 패널의 `마지막 시도`, `마지막 확인`, `마지막 반영`에서 타이머 실행과 서버
  응답, 실제 캐릭터 저장을 각각 구분해 볼 수 있습니다.
- `status: "ready"`인 schema 1 스냅샷만 캐릭터에 적용합니다.
- `status: "no-active-project"`이면 기존 로어북을 지우지 않고 대기합니다.
- 로컬 연결에서는 `/v1/projects` 목록에서 프로젝트를 선택하고, 이후
  `/v1/projects/<project.id>/manifest`와 개별 문서 API를 폴링하므로
  Obsidian의 활성 문서와 무관하게 연결한 프로젝트를 유지합니다.
- 릴레이 연결은 채널에 업로드된 단일 스냅샷을 사용하므로 현재 릴레이
  스냅샷과 캐릭터에 연결된 `project.id`가 같을 때만 `globalLore`를 교체합니다.
- `Description으로 옮길 항목 이름`을 설정하면 해당 `comment`의 항목을
  캐릭터 description으로 옮기고 로어북에서는 제외합니다.

## DEBUG 로그

소스의 `DEBUG` 상수가 `true`이면 최근 로그와 RisuAI 개발자 콘솔에 플러그인
인스턴스 ID, 타이머 생성/틱/종료, 중복 실행 차단, API별 요청·응답·
not-modified·timeout, 문서 diff, 캐릭터 읽기/저장, unload가 기록됩니다.
기본값은 `false`입니다.
인스턴스 ID가 바뀌면 RisuAI가 플러그인을 다시 로드한 것입니다.
