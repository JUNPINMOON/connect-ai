# validate-registry — 검증 명령 스펙 (Codex 구현용)

> 레지스트리가 늘수록 JSON 오타 하나로 Connect AI가 오작동 가능. Claude가 스키마를 설계했고,
> 실제 `validate-registry` 명령은 Codex(손발)가 구현한다.

## 대상 파일 ↔ 스키마
| 파일 | 스키마 |
|---|---|
| `config/project-registry.json` | `config/schemas/project-registry.schema.json` |
| `config/tool-registry.json` | `config/schemas/tool-registry.schema.json` |
| `config/port-registry.json` | `config/schemas/port-registry.schema.json` |
| `config/env-policy.json` | `config/schemas/env-policy.schema.json` |

## 명령 동작 (제안)
`validate-registry`는:
1. 각 JSON을 파싱 (실패 시 파일명+위치 보고).
2. 대응 JSON Schema(draft-07)로 검증.
3. **스키마로 표현 못 하는 교차 규칙**도 점검:
   - port-registry: `port` 값 **중복 없음**.
   - tool-registry: `projectId`가 project-registry의 `id`에 실제 존재.
   - 모든 `url`/host가 runtime-policy의 `defaultHostPolicy`(127.0.0.1)거나 `hostOverrideApproved:true`.
   - project-registry: 모든 department `id`가 env-policy `departments` 키와 매칭(누락 경고).
   - 모든 항목 `mutable:false` (true면 에러).
4. 결과: PASS/FAIL + 항목별 사유. 종료코드 0/1.

## 구현 힌트 (Node, 확장이 TS라서)
- `ajv`로 draft-07 검증, 교차 규칙은 별도 함수.
- VS Code 명령으로 노출: `connectAiLab.validateRegistry` → Output Channel에 결과(단, env 값은 출력 금지, env-policy redaction 적용).
- CI/pre-commit에도 같은 로직 재사용.

## 완료 정의
- 일부러 깨뜨린 JSON(필드 오타/포트 중복/mutable:true)을 넣으면 FAIL + 정확한 사유.
- 정상 4종은 PASS.
