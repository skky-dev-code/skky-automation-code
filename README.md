# skky-automation-code

대학 발송 콘솔 — Notion DB 기반 등급별 메일 발송 대시보드.

## Stack

- Node.js + Express
- Notion API (`@notionhq/client` v5)
- Vanilla JS frontend (single-file `index.html`)

## Local 실행

```bash
cp .env.example .env
# .env 에 NOTION_TOKEN, NOTION_DATABASE_TEST, NOTION_DATABASE_PROD 채우기
npm install
npm start
# → http://localhost:3000
```

## 환경 변수

| Key                    | 설명                                          |
| ---------------------- | --------------------------------------------- |
| `NOTION_TOKEN`         | Notion integration secret (`ntn_...`)         |
| `NOTION_DATABASE_TEST` | 테스트 DB ID (32자)                           |
| `NOTION_DATABASE_PROD` | 프로덕션 DB ID (32자)                         |
| `NOTION_PROP_CODE`     | "대학코드" 컬럼명 (기본값: 대학코드)         |
| `NOTION_PROP_NAME`     | "대학명" 컬럼명 (기본값: 대학명)              |
| `NOTION_PROP_TIER`     | "신청등급" 컬럼명 (기본값: 신청등급)          |
| `PORT`                 | 포트 (기본값: 3000)                           |

## Notion DB 권한

각 DB의 `⋯ → Connections → +` 에서 integration 추가 필요.

## API

- `GET /api/envs` — 사용 가능한 환경 목록
- `GET /api/health?env=test|prod` — 연결/스키마 확인
- `GET /api/universities?env=test|prod` — 대학 목록
- `POST /api/send` — 발송 (현재 시뮬레이션)

## Vercel 배포

1. https://vercel.com 에서 **Add New → Project** → 이 GitHub repo 선택
2. **Framework Preset**: Other (자동 인식)
3. **Environment Variables** 추가:
   - `NOTION_TOKEN`
   - `NOTION_DATABASE_TEST`
   - `NOTION_DATABASE_PROD` (있다면)
4. **Deploy** 클릭

배포 구조:
- `api/[[...path]].js` — Express 앱을 catch-all serverless 함수로 감쌈
- `index.html` — Vercel이 정적 파일로 자동 서빙
- `vercel.json` — `includeFiles`로 함수 번들에 정적 파일 포함
