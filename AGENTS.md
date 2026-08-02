# Repository instructions

## Build and deployment

- 소스 변경을 완료하면 테스트와 타입 검사를 실행한다.
- 최종 빌드가 성공한 뒤 `npm run deploy`를 실행하여 `dist/main.js`, `dist/manifest.json`, `dist/styles.css`를 `deploy.local.json`에 설정된 Obsidian 플러그인 폴더로 배포한다.
- 배포 후 대상 파일이 빌드 산출물과 일치하는지 확인한다.
