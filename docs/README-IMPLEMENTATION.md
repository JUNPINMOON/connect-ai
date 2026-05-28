# Connect AI Phase 1 Implementation

## 완료된 구현

### 1) 모델 라우팅 자동화 ✅
- **파일**: `src/model-router.js`, `config/model-routing.json`
- **기능**: 작업 유형과 리스크에 따라 자동 모델 선택
- **사용법**: `node src/model-router.js <action> <risk>`
- **라우팅 규칙**:
  - analysis/low→openrouter:z-ai/glm-4.6
  - implementation/medium→delegate:codex
  - sensitive/high→local
  - creative/low→bedrock:claude-sonnet-4

### 2) 유튜브 부서 URL 수집 파이프라인 ✅
- **파일**: `youtube/url-collector.js`, `youtube/processor.js`
- **기능**: YouTube URL 큐브 시스템 및 처리 파이프라인
- **사용법**: 
  - `node youtube/url-collector.js add "url1,url2"`
  - `node youtube/processor.js process`
- **저장 위치**: `/mnt/c/Users/mjb58/connect-ai-vault/youtube/`

### 3) 에이전트 상호연결 코디네이터 ✅
- **파일**: `agent-coordinator/coordinator.js`
- **기능**: 에이전트 간 작업 위임 및 조율
- **사용법**: `node agent-coordinator/coordinator.js delegate <taskType>`
- **에이전트**: Hermes(primary), Codex(worker), Claude(expert)

## 테스트 결과

### 모델 라우터
```bash
$ node src/model-router.js analyze low
Recommended: openrouter:z-ai/glm-4.6
Confidence: 0.9
Reasoning: Matched rule: analysis/low

$ node src/model-router.js implement medium
Recommended: delegate:codex
Confidence: 0.9
Reasoning: Matched rule: implementation/medium
```

### 유튜브 URL 수집기
```bash
$ node youtube/url-collector.js add "https://youtu.be/dQw4w9WgXcQ,https://www.youtube.com/watch?v=9bZkp7q19f0"
Added 2 URLs to queue: /mnt/c/Users/mjb58/connect-ai-vault/youtube/queue/batch-2026-05-24T23-07-09-981Z.json

$ node youtube/url-collector.js status
Queue Status: { total: 2, queued: 2, processing: 0, completed: 0, failed: 0 }
```

### 에이전트 코디네이터
```bash
$ node agent-coordinator/coordinator.js status
Agent Status: {
  "hermes": { "type": "primary", "endpoint": "local", "status": "available" },
  "codex": { "type": "worker", "endpoint": "delegate", "status": "available" },
  "claude": { "type": "expert", "endpoint": "bedrock", "status": "available" }
}
```

## Phase 2 계획 (2주 내)

### 1) YouTube 콘텐츠 제작 워크플로우
- Hermes ↔ Claude/Codex 위임하여 콘텐츠 생성
- 수집 → 분석 → 대본 → 게시 파이프라인 완성
- 게시 전 정책 게이트 승인 프로세스

### 2) 재귀 MCP 메시 구현
- Codex → Claude 직접 통신 채널
- 에이전트 간 상태 공유 메커니즘
- 작업 위임 추적 시스템

## Phase 3 계획 (1개월 내)

### 1) YouTube 운영 대시보드
- 진행 상태, 큐, 결과 시각화
- http://127.0.0.1:8766 포트 할당

### 2) Claude API 연동
- Bedrock/Console API 설정
- OAuth 제약 우회 구현

### 3) 에이전트 코디네이터 고도화
- 충돌 방지 및 우선순위 관리
- 상태 동기화 개선

## 다음 단계

1. **즉시**: YouTube URL 테스트 ingest 실행
2. **오늘**: 모델 라우터 Hermes 연동
3. **이번 주**: 에이전트 코디네이터 실제 작업 위임 테스트

## 보안 및 안정성

- 모든 작업은 gate_check 통해 승인 필요
- 민감 정보 처리 시 local 모델 자동 선택
- 실패 시 fallback 프로세스 구현
- 비용 제어를 위한 API 사용량 모니터링

## 파일 구조

```
connect-ai/
├── src/
│   └── model-router.js          # 모델 라우팅 엔진
├── config/
│   └── model-routing.json       # 라우팅 규칙 설정
├── youtube/
│   ├── url-collector.js         # URL 수집 파이프라인
│   └── processor.js             # 콘텐츠 처리 파이프라인
├── agent-coordinator/
│   └── coordinator.js           # 에이전트 코디네이터
├── state/                       # 작업 상태 저장
└── README-IMPLEMENTATION.md     # 이 파일
```

## 연동 포인트

- **Hermes**: 기본 실행 환경 및 MCP 서버
- **VS Code 확장**: ACP 프로토콜로 Hermes 연결
- **Connect AI Vault**: 모든 상태 및 결과 저장
- **Codex**: 구현 작업 위임 대상
- **Claude**: 고차원적 분석 및 설계 작업
