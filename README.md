# 식자재 발주 도우미 (해커톤 주제 1)

과제·명세: `식자재_관리_및_발주_자동화_요구사항과_데이터명세서.md`
⚠ 제공 CSV는 공개 저장소 게시 금지 — `data/raw/`, `*.csv`, 생성 JSON은 `.gitignore` 처리됨.

## 구조
```
data/raw/        제공 CSV 01~17 넣는 곳
pipeline/        Python 전처리 (schema → validate → build → load_db)
  fixtures/      개발용 합성 CSV (제공 데이터 아님, make_fixtures.py 로 생성)
docs/            제출물 템플릿 + 추가 아이디어
web/             Next.js 앱 (Vercel 배포)
  src/lib/engine 발주·재고 계산 엔진 (순수 함수, vitest)
  src/lib/data.ts 스냅샷 조회: DB 우선 → 실패 시 번들 JSON
  src/db         Drizzle (app_* 테이블만 관리)
```

## 10/31 데이터 공개 후 순서
```bash
# 1) CSV 복사 → data/raw/
py pipeline/validate.py            # 리포트: pipeline/reports/validation.md → 가정 확인
py pipeline/build.py               # web/src/data/generated/*.json (폴백 데이터)

# 2) 로컬 확인
cd web && npm run dev              # http://localhost:3000
npm test                           # 엔진 테스트

# 3) DB (최초 1회: Vercel 프로젝트 연결 + Marketplace에서 Neon 추가)
vercel link && vercel env pull .env.local
npm run db:push                    # app_* 테이블 생성
cd .. && py pipeline/load_db.py    # raw_*/agg_* 적재

# 4) 배포 (git 공개 저장소 없이 CLI로)
cd web && vercel deploy --prod
```

## 데이터 없이 개발할 때
```bash
py pipeline/make_fixtures.py
py pipeline/build.py --raw pipeline/fixtures
```
화면 상단에 "개발용 합성 픽스처" 경고가 뜹니다. 배포 전 반드시 실제 데이터로 `build.py`를 다시 실행하세요.

## 10/31 확인할 TODO
코드에서 `TODO(10/31)` 검색: 요일·목록 표기 형식, 리드타임 기준, receipts.status 코드, 가정 문구 갱신.
