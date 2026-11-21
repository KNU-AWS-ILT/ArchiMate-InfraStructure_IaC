# 🏗️ ArchiMate, "나의 첫 간편 클라우드 서비스"

> 혼자서도 관리할 수 있는 서비스로 바꿔 주는 AI 클라우드 설계 플랫폼입니다!

## 🎥 배포·시연 영상 링크

| 구분 | URL |
| :---: | :--- |
| **프론트엔드** | - |
| **백엔드** | - |
| **인프라** | - |

---

## ✨ 인프라 핵심 기능 (Key Feature)

> 이 레포는 ArchiMate를 AWS에 올리는 **AWS CDK 코드**만 담습니다. 백엔드·프론트엔드 코드는 각 레포에 있고, 배포할 때 경로(`-c backendPath`, `-c webAssetPath`)로 불러옵니다.
> 서울 리전(`ap-northeast-2`)에 서버 없이(서버리스) 구성하고, 모든 리소스 이름은 `archimate-{스테이지}-{서비스}-{용도}`, 태그는 `Project` · `Environment` · `Owner` 3종입니다.
> 표시한 **(임시값)**은 명세에 없어서 인프라가 정한 값이며, 백엔드·PM과 협의 후 확정합니다.

### 1. 서버리스 API (API Gateway + Lambda 3개)

* **기능 소개**

> 요청을 받는 REST API(리전 엔드포인트)와 Lambda 3개를 만듭니다. 모든 라우트는 Lambda 프록시 통합이며, Cognito 로그인 토큰을 API Gateway에서 먼저 확인합니다.
> - **설계 생성 `generate`** (제한 시간 180초): `POST /api/v1/designs`를 받으면 jobId를 저장하고, **자기 자신을 비동기로 호출한 뒤 바로 `202 { jobId }`로 응답**합니다. 같은 Lambda가 작업 상태 조회와 운영 절차 조회도 처리합니다. 비동기 호출 재시도는 끕니다. 백엔드 코드가 안에서 재시도하므로, AWS가 다시 실행하면 LLM 호출이 중복되기 때문입니다. **(임시값)**
> - **노드 설명 `explain`** (제한 시간 25초): `GET .../nodes/{nodeId}/explanation`을 처리합니다. 소형 모델 ID는 환경 변수 `LLM_EXPLAIN_MODEL`로 받습니다.
> - **단가 동기화 `sync_prices`** (제한 시간 300초 **(임시값)**): EventBridge가 **매일 한국 시간 03:00(UTC 18:00) (임시값)**에 실행해 Price List API(us-east-1)의 단가를 `prices` 테이블에 덮어씁니다.
> - 공통: Python 3.12, ARM64, 로그 보존 2주(스택을 지우면 로그도 삭제), 메모리는 Lambda 기본값(128MB). Lambda마다 **필요한 테이블 권한만** 줍니다. (`generate`: designs 읽기·쓰기 + prices 읽기, `explain`: designs 읽기 + explanations 읽기·쓰기, `sync_prices`: prices 쓰기)
> - Bedrock은 Lambda마다 **추론 프로필과 파운데이션 모델, 두 곳만** 호출할 수 있습니다(와일드카드 없음). 모델 ID는 `global.anthropic.claude-opus-5-5`(설계), `global.anthropic.claude-haiku-5-5`(설명)이며 배포 전에 `list-inference-profiles`로 실제 ID를 확인합니다. (백엔드 #15·#22)
> - 스로틀: 모든 경로에 초당 10회, 순간 20회 **(임시값)**. Bedrock 비용이 갑자기 늘지 않게 막는 용도입니다.
> - CORS는 설정하지 않습니다. 프론트가 같은 주소(CloudFront)의 `/api/v1`만 호출하기 때문입니다.
> - API Gateway가 직접 보내는 오류(401·403·429·504·그 밖의 4xx·5xx)도 `{ code, message, retryable, requestId }` 형식으로 맞춥니다. 401과 403만 `UNAUTHORIZED`로 구분하고(백엔드 FastAPI와 같은 기준), 504→`LLM_TIMEOUT`, 그 밖의 4xx→`INVALID_REQUEST`는 백엔드 #15에서 확인했습니다.

* **구성도**

> ```text
> POST /api/v1/designs                              ─┐
> GET  /api/v1/designs/jobs/{jobId}                  ├─▶ generate Lambda (180초)
> GET  /api/v1/designs/{designId}/guide             ─┘      ├─ DynamoDB designs (읽기·쓰기), prices (읽기)
>                                                           ├─ Bedrock 설계용 모델
>                                                           └─ 자기 자신 비동기 호출 (POST 접수 → 202 응답 후 생성)
> GET  /api/v1/designs/{designId}/nodes/{nodeId}/explanation
>                                                   ──────▶ explain Lambda (25초)
>                                                           ├─ DynamoDB designs (읽기), explanations (읽기·쓰기)
>                                                           └─ Bedrock 소형 모델
>
> ※ 위 4개 라우트는 모두 API Gateway의 Cognito Authorizer를 거칩니다.
>
> EventBridge (매일 03:00 KST) ──▶ sync_prices Lambda ──▶ Price List API (us-east-1) ──▶ DynamoDB prices (쓰기)
> ```

### 2. 정적 웹 배포 (S3 + CloudFront)

* **기능 소개**

> 프론트엔드(Next.js 정적 내보내기 결과물)를 올리고, 한 개의 CloudFront 주소로 화면과 API를 함께 서비스합니다.
> - **S3**: 퍼블릭 접근을 모두 막고, SSL이 아닌 요청을 거부하며, **CloudFront만 OAC로 읽습니다.** 스택을 지우면 파일까지 함께 삭제됩니다.
> - **CloudFront 기본 동작**: S3에서 파일을 가져오고, HTTPS로 리다이렉트하며, 보안 헤더 정책과 캐시 최적화 정책을 씁니다.
> - **CloudFront `/api/*` 동작**: 1번 기능의 API Gateway로 보냅니다. 캐시는 끄고, 모든 HTTP 메서드를 허용하며, `Authorization` 헤더와 쿼리 문자열을 그대로 넘깁니다(Host 헤더만 제외). API Gateway의 호출 주소가 `/{스테이지 이름}/api/v1/...`이라 오리진 경로에 스테이지 이름(`/demo`)을 지정합니다.
> - **CloudFront Function**: 주소가 `/`로 끝나면 `index.html`을 붙입니다. (예: `/designs/` → `/designs/index.html`) 모든 경로를 `/index.html`로 보내는 SPA 방식은 쓰지 않습니다. (`trailingSlash: true` 정적 내보내기에 맞춤)
> - **오류 페이지(404→index.html)는 설정하지 않습니다.** 설정하면 API 오류 응답까지 HTML로 바뀌기 때문입니다.
> - **업로드·캐시 무효화**: `cdk deploy` 때 프론트 결과물을 S3에 올리고 `/*` 캐시를 자동으로 무효화합니다. `webAssetPath` 폴더에 `index.html`이 없으면 레포 안의 플레이스홀더 페이지(`web-placeholder/`)를 올립니다.
> - 출력값 `cloudFrontUrl`이 배포 후 접속 주소입니다.

* **구성도**

> ```text
> 브라우저 ──HTTPS──▶ CloudFront
>                      ├─ 기본 (/*)  ─▶ [CloudFront Function: `/`로 끝나면 index.html 붙임] ─▶ S3 (비공개, OAC)
>                      │                                                                       ▲
>                      │                                         cdk deploy: 업로드 + `/*` 캐시 무효화 ┘
>                      └─ /api/*     ─▶ API Gateway (오리진 경로 /demo, 캐시 끔, 모든 메서드, Authorization 전달)
> ```

### 3. 데이터·인증·비용 관리 (DynamoDB, Cognito, Budgets)

* **기능 소개**

> - **DynamoDB 테이블 3개** (모두 온디맨드, 삭제 정책 DESTROY. 발표 직후 `cdk destroy` 한 번으로 남지 않게 합니다)
>   - `designs`: 파티션 키 `jobId`, 시점 복구(PITR) 켬, TTL `expiresAt`
>   - `prices`: 파티션 키 `service` + 정렬 키 `regionUsageType`, TTL 없음(매일 덮어씀)
>   - `explanations`: 파티션 키 `designId` + 정렬 키 `nodeId`, TTL `expiresAt`
>   - 키 구조와 TTL 속성 이름은 백엔드 #15에서 확정했습니다. 만료 시각 계산은 Lambda가 합니다.
> - **Cognito**: User Pool과 SPA용 앱 클라이언트(client secret 없음)를 만들고, `userPoolId`, `userPoolClientId`를 출력값으로 내보냅니다. 로그인 방식(SDK 직접 로그인 / Hosted UI), 자가 가입, 로그인 아이디(이메일 / 사용자 이름)는 프론트·PM 회신을 기다리는 중이라 **CDK 기본값**입니다.
> - **AWS Budgets**: 월 **30 USD**, 실제 비용 50%·80%, 예측 비용 100%에 이메일을 보냅니다. 운영 알림은 Budgets뿐이며 CloudWatch 알람·대시보드·SNS 토픽은 만들지 않습니다. (백엔드 #7) 알림 받을 이메일(`-c alertEmail`)이 없으면 Budgets를 만들지 않고 synth 경고만 냅니다. Budgets는 계정 전체 비용을 기준으로 합니다.

* **구성도**

> ```text
> 사용자 로그인 ──▶ Cognito User Pool (앱 클라이언트: SPA용, secret 없음)
>                       │ 토큰 확인
>                       ▼
>                 API Gateway ──▶ Lambda ──▶ DynamoDB
>                                              ├─ designs        jobId                  (PITR, TTL)
>                                              ├─ prices         service / regionUsageType
>                                              └─ explanations   designId / nodeId      (TTL)
>
> AWS Budgets (월 30 USD) ──▶ 실제 50%·80%, 예측 100% ──▶ 이메일
> ```

---

## 🖼️ 전체 서비스 한눈에 보기

> 

---

## ⚙️ 시스템 아키텍처

> 서울 리전(`ap-northeast-2`), VPC 없는 서버리스 구성입니다. 스택은 `archimate-{스테이지}` 1개이고 스테이지 기본값은 `demo`입니다.

```text
브라우저
   │ HTTPS
   ▼
CloudFront ─┬─ /*     ─▶ S3 (프론트 정적 파일, 비공개 + OAC)
            │            └─ CloudFront Function: `/`로 끝나는 주소에 index.html
            └─ /api/* ─▶ API Gateway (REST, Cognito Authorizer)
                           ├─ POST /api/v1/designs                           ─┐
                           ├─ GET  /api/v1/designs/jobs/{jobId}               ├─▶ generate Lambda ─┬─▶ DynamoDB (designs, prices)
                           ├─ GET  /api/v1/designs/{designId}/guide          ─┘                    ├─▶ Bedrock (설계용 모델)
                           │                                                                       └─▶ generate (자기 자신, 비동기)
                           └─ GET  /api/v1/designs/{designId}/nodes/{nodeId}/explanation
                                                                              ─▶ explain Lambda ───┬─▶ DynamoDB (designs, explanations)
                                                                                                   └─▶ Bedrock (소형 모델)

EventBridge (매일 03:00 KST, 임시값) ─▶ sync_prices Lambda ─▶ Price List API (us-east-1) ─▶ DynamoDB (prices)
AWS Budgets (월 30 USD) ─▶ 이메일 알림
```

## ⛏️ 기술 스택

| 구분 | 기술 스택 |
| :---: | :--- |
| **IaC** | AWS CDK v2 (`aws-cdk-lib`), 테스트 Jest |
| **프로그래밍 언어** | TypeScript (Node.js 26) / Lambda 더미 핸들러는 Python 3.12 |
| **AWS 서비스** | CloudFront, S3, API Gateway(REST), Lambda(Python 3.12, ARM64), DynamoDB, Cognito, EventBridge, Budgets, IAM, CloudWatch Logs(Lambda 로그) / Lambda가 호출하는 Bedrock·Price List API(권한만 부여) |
| **CI/CD** | GitHub Actions (예정) |

---

## 🏗️ 레포 구조

> 인프라 코드(CDK)만 두고, 백엔드·프론트엔드 코드는 두지 않습니다. 아래 `lambda-stub/`는 백엔드 코드가 준비되기 전에 CDK 합성·테스트에 쓰는 더미 핸들러입니다.

```text
ArchiMate-InfraStructure_IaC/
├── bin/
│   └── archimate-infra.ts       CDK 앱 진입점 (스택 1개를 만든다)
├── lib/
│   ├── archimate-stack.ts       스택 조립 (아래 구성 요소를 연결하고 태그 3종을 붙인다)
│   ├── config.ts                설정 (리전, 스테이지, 모델 ID, 예산, 스로틀, 스케줄, 경로, 이름 규칙 함수)
│   ├── data.ts                  DynamoDB 테이블 3개
│   ├── auth.ts                  Cognito User Pool, 앱 클라이언트
│   ├── functions.ts             Lambda 3개, IAM 권한, 환경 변수
│   ├── api.ts                   API Gateway, Cognito Authorizer, 게이트웨이 오류 응답
│   ├── web.ts                   S3, CloudFront, CloudFront Function, 프론트 업로드·캐시 무효화
│   ├── schedule.ts              EventBridge 단가 동기화 스케줄
│   └── budget.ts                AWS Budgets
├── lambda-stub/archimate/handlers/   더미 핸들러 (백엔드 코드와 같은 모듈 경로)
├── web-placeholder/index.html   프론트 결과물이 없을 때 올리는 임시 페이지
├── test/                        Jest 테스트 (lib/ 파일마다 1개)
├── cdk.json                     CDK 실행 설정, feature flag
├── package.json · tsconfig.json · jest.config.js
├── .env.example                 CDK 실행 옵션 안내 (값은 비움)
├── .nvmrc                       Node 버전 고정 (26)
└── .editorconfig · .gitattributes · .gitignore
```

---

## 🚀 배포 방법

> **개발 중에는 배포하지 않습니다.** 비용 0원 원칙에 따라 `cdk synth`(AWS 계정·자격 증명이 필요 없음)와 테스트로만 확인합니다. AWS 배포는 발표 1주 전에 한 번, 인프라 담당이 합니다.

### 1. 개발 중: 합성과 테스트

> Node.js 26(`.nvmrc`)을 사용합니다. AWS에는 아무것도 만들지 않습니다.

```shell
npm ci
npx tsc --noEmit        # 타입 검사
npm test                # Jest
npx cdk synth           # CloudFormation 템플릿 생성 (cdk.out/)
```

> 실행 옵션은 `-c 키=값`으로 넘깁니다.
>
> | 옵션 | 설명 | 기본값 |
> | :--- | :--- | :--- |
> | `stage` | 스테이지 이름. 리소스 이름과 `Environment` 태그, CloudFront 오리진 경로에 쓰임 | `demo` |
> | `alertEmail` | Budgets 알림 이메일. 없으면 Budgets를 만들지 않음 | 없음 |
> | `lambdaCode` | Lambda 코드 출처. `stub`(레포 안 더미) 또는 `backend`(백엔드 레포 `src/`) | `stub` |
> | `backendPath` | 백엔드 레포 경로 | `../ArchiMate-Backend` |
> | `webAssetPath` | 프론트 정적 내보내기 결과물 경로. `index.html`이 없으면 플레이스홀더를 올림 | `../ArchiMate-Frontend/out` |
> | `llmProvider` | `bedrock` 또는 `mock` (개발 중 배포는 `mock`) | `bedrock` |

### 2. 막바지 AWS 배포 (발표 1주 전)

> 먼저 준비할 것: AWS 계정(Free 플랜), Bedrock 콘솔에서 Anthropic 모델 사용 신청, 실제 모델 ID 확인, 프론트 정적 내보내기 결과물.
> **`-c alertEmail`은 반드시 넘깁니다.** 빠뜨리면 Budgets 없이 배포됩니다.
> 백엔드 코드의 pip 의존성 번들은 아직 구현 전입니다. 지금의 `-c lambdaCode=backend`는 백엔드 `src/` 폴더만 묶습니다.

```shell
aws bedrock list-inference-profiles --region ap-northeast-2   # global.anthropic.claude-opus-5-5 / haiku-5-5 확인
npx cdk bootstrap                                             # 계정·리전당 최초 1회
npx cdk deploy -c alertEmail=<알림 받을 이메일> -c lambdaCode=backend -c backendPath=<백엔드 레포 경로> -c webAssetPath=<프론트 out 경로>
```

> 배포가 끝나면 출력값 `cloudFrontUrl`(접속 주소), `userPoolId`, `userPoolClientId`가 나옵니다. Budgets 구독 확인 메일을 확인하고, 접속 주소에서 로그인 → 3안 생성 → 노드 설명 → 운영 절차까지 동작하는지 봅니다.
> 이 배포는 나중에 수동 실행(GitHub Actions `workflow_dispatch`)으로도 할 수 있게 만들 예정입니다. 그때도 장기 액세스 키 대신 OIDC로 인증하는 것이 원칙입니다.

### 3. 발표 직후: 삭제

> 서버리스라 쓰지 않을 때 비용이 거의 없지만, 발표가 끝나면 바로 지웁니다.

```shell
npx cdk destroy
```

> 삭제 확인 순서: 스택이 삭제됐는지 확인 → 남은 S3·DynamoDB 확인 → `Project=ArchiMate` 태그로 남은 리소스 검색.
> S3 자동 삭제용 도우미 Lambda의 로그 그룹(`/aws/lambda/...S3AutoDeleteObjects...`)은 스택 밖에서 남을 수 있으니 함께 찾아봅니다.

---

## 📋 스택 구성

| 스택 | 주요 리소스 | 주요 기능 |
| :--- | :---: | :--- |
| `archimate-demo` | DynamoDB 3개 (`designs`, `prices`, `explanations`) | 설계 결과, 단가, 노드 설명 캐시 저장. 모두 온디맨드 |
| `archimate-demo` | Cognito User Pool 1개, 앱 클라이언트 1개 | 로그인 토큰 발급 (API 호출 전 인증) |
| `archimate-demo` | Lambda 3개 (`generate`, `explain`, `sync_prices`), 로그 그룹 3개 | 3안 생성·조회, 노드 설명, 단가 동기화. (CDK가 S3 업로드·자동 삭제용 도우미 Lambda를 2개 더 만듦) |
| `archimate-demo` | API Gateway REST API 1개, Authorizer 1개, 라우트 4개, 게이트웨이 오류 응답 6종 | `/api/v1/...` 요청 접수와 인증, 오류 응답 형식 통일 |
| `archimate-demo` | S3 버킷 1개, CloudFront 배포 1개, CloudFront Function 1개, OAC 1개 | 프론트 정적 파일 서비스, `/api/*`를 API Gateway로 전달 |
| `archimate-demo` | EventBridge 규칙 1개 | 매일 새벽 `sync_prices` 실행 (임시값) |
| `archimate-demo` | Budgets 1개 | 월 30 USD, 실제 50%·80%, 예측 100% 이메일 알림 |
