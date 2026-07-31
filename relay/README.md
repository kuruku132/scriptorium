# Scriptorium relay

Cloudflare Worker와 KV를 이용해 채널별 최신 스냅샷 하나를 보관합니다.

1. `npm install`
2. `npx wrangler kv namespace create SNAPSHOTS`
3. 출력된 namespace ID를 `wrangler.jsonc`에 입력
4. 인증이 필요하면 `npx wrangler secret put BEARER_TOKEN`
5. `npm run deploy`

토큰을 설정하지 않으면 push와 pull 모두 무인증입니다. 토큰을 설정하면 두
요청 모두 동일한 `Authorization: Bearer …` 헤더가 필요합니다. 저장소의
`npm run relay:deploy`는 이 디렉터리의 배포 명령을 호출할 뿐이며, 플러그인
로컬 배포와는 독립적입니다.
