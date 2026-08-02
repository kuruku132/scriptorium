# Scriptorium relay

Cloudflare Worker와 KV를 이용해 채널별 최신 스냅샷 하나를 보관합니다.

## Cloudflare 대시보드에서 직접 업로드

이 `relay` 폴더를 그대로 업로드합니다. 실행 코드는 빌드 과정이나 Wrangler
설정이 필요 없는 단일 `_worker.js` 파일입니다.

업로드 후 Worker 설정에서 다음 바인딩을 추가해야 합니다.

1. KV 네임스페이스를 하나 생성합니다.
2. Worker의 **Bindings**에서 해당 네임스페이스를 연결합니다.
3. 변수 이름을 정확히 `SNAPSHOTS`로 지정합니다.
4. 인증이 필요하면 환경 변수 또는 secret `BEARER_TOKEN`을 추가합니다.

KV 생성과 바인딩은 Worker JS 파일 업로드에 포함할 수 없는 계정 리소스
설정입니다. `BEARER_TOKEN`을 설정하지 않으면 push와 pull 모두 무인증입니다.
설정하면 두 요청 모두 동일한 `Authorization: Bearer …` 헤더가 필요합니다.
