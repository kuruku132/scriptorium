# Repository instructions

## Build and deployment

- 소스 변경을 완료하면 `npm run finalize`를 실행한다.
- 이 명령은 타입 검사, 테스트, 최종 빌드, `deploy.local.json`에 설정된 Obsidian 플러그인 폴더로의 배포, 산출물 SHA-256 일치 검증을 순서대로 수행한다.
- 어느 단계든 실패하면 배포 완료로 간주하지 않는다.
