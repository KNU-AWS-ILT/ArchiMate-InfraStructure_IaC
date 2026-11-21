import * as fs from 'fs';
import * as path from 'path';
import { App } from 'aws-cdk-lib';

/** 서울 리전. (Price List API만 us-east-1을 쓰며, 해당 Lambda 코드에서 지정한다) */
export const REGION = 'ap-northeast-2';

/** 월 예산(USD). Budgets 알람 기준. */
export const MONTHLY_BUDGET_USD = 30;

/** Budgets 알림 기준. 실제 비용 50%·80%, 예측 비용 100%. (인프라 #6) */
export const BUDGET_ALERTS = [
  { type: 'ACTUAL', thresholdPercent: 50 },
  { type: 'ACTUAL', thresholdPercent: 80 },
  { type: 'FORECASTED', thresholdPercent: 100 },
] as const;

/**
 * 단가 동기화(sync_prices) 실행 시각. EventBridge cron은 UTC 기준이다.
 * 명세 없음, 임시값. 명세에는 "매일 새벽"만 있어서 한국 시간 03:00(UTC 18:00)으로 정했다.
 */
export const SYNC_PRICES_SCHEDULE = { minute: '0', hour: '18' } as const;

/** 모든 리소스에 붙이는 태그 값 [conventions 11번] */
export const TAG_PROJECT = 'ArchiMate';
export const TAG_OWNER = 'infra';

/** 스테이지를 지정하지 않을 때 기본값. AWS는 막바지에 한 번만 배포하므로 1개만 쓴다. */
export const DEFAULT_STAGE = 'demo';

/**
 * DynamoDB TTL 속성 이름. 백엔드 #15 확정.
 * `designs`와 `explanations` 테이블에 적용한다. (`prices`는 TTL 없음)
 */
export const TTL_ATTRIBUTE_NAME = 'expiresAt';

/**
 * Bedrock 추론 프로필 ID. 백엔드 #15·#22 확정. Lambda 환경 변수(`LLM_MODEL`, `LLM_EXPLAIN_MODEL`)에 그대로 들어간다.
 * 배포 전 확인 필요: 실제 ID는 `aws bedrock list-inference-profiles --region ap-northeast-2`로 확인한다. (MVP_Task.md 7단계)
 */
export const BEDROCK_MODEL_IDS = {
  design: 'global.anthropic.claude-opus-5-5',
  explain: 'global.anthropic.claude-haiku-5-5',
} as const;

/**
 * 위 추론 프로필이 가리키는 파운데이션 모델 ID (`global.` 접두사 없음). IAM 권한 범위에 쓴다. 백엔드 #15·#22 확정.
 * 배포 전 확인 필요: 위 추론 프로필 ID와 함께 확인한다.
 */
export const BEDROCK_FOUNDATION_MODEL_IDS = {
  design: 'anthropic.claude-opus-5-5',
  explain: 'anthropic.claude-haiku-5-5',
} as const;

/**
 * Lambda 진입 함수. 백엔드 #15 확정. 모듈 경로는 `archimate/handlers/*.py`.
 * 더미(lambda-stub)와 백엔드 코드가 같은 모듈 경로를 쓰므로 코드 위치만 바꾸면 된다.
 */
export const LAMBDA_HANDLERS = {
  generate: 'archimate.handlers.generate.handler',
  explain: 'archimate.handlers.explain.handler',
  syncPrices: 'archimate.handlers.sync_prices.handler',
} as const;

/** Lambda 제한 시간(초). generate 180, explain 25는 백엔드 #7 합의. */
export const LAMBDA_TIMEOUT_SECONDS = {
  generate: 180,
  explain: 25,
  // 명세에 없음. 기본값 3초로는 Price List API 호출이 끝나지 않아 임시로 300초로 둔다. (백엔드(API·비용) 확인 필요)
  syncPrices: 300,
} as const;

/** 테이블 이름을 Lambda에 넘기는 환경 변수 이름. 백엔드 #15. 각 Lambda에는 필요한 것만 넘긴다. */
export const TABLE_ENV_VARS = {
  designs: 'DESIGNS_TABLE',
  prices: 'PRICES_TABLE',
  explanations: 'EXPLANATIONS_TABLE',
} as const;

/**
 * LLM 제공자 기본값. 최종 AWS 배포는 Bedrock이다.
 * 개발 중 배포는 `-c llmProvider=mock`으로 바꾼다. (백엔드 #15 syd348)
 */
export const DEFAULT_LLM_PROVIDER = 'bedrock';

/** `-c llmProvider`로 고를 수 있는 값. gemini·anthropic은 API 키 전달 방법이 정해지지 않아 막아 둔다. */
export const LLM_PROVIDERS = ['bedrock', 'mock'] as const;

/**
 * API Gateway 스테이지 스로틀 (모든 경로·메서드 공통). Bedrock 비용 폭주를 막는 용도다.
 * 명세 없음, 임시값. 추후 백엔드·PM과 협의 후 확정한다.
 */
export const API_THROTTLE = {
  /** 초당 요청 수 */
  rateLimit: 10,
  /** 순간 최대 요청 수 */
  burstLimit: 20,
} as const;

/** Lambda 코드 위치. `stub`은 IaC 레포 안의 더미, `backend`는 백엔드 레포의 `src/`. */
export type LambdaCodeSource = 'stub' | 'backend';

/** IaC 레포 안의 더미 핸들러 폴더. 백엔드 코드가 main에 올라오기 전까지 쓴다. */
export const LAMBDA_STUB_PATH = path.resolve(__dirname, '..', 'lambda-stub');

/** 프론트 결과물(index.html)이 없을 때 올리는 플레이스홀더 페이지 폴더 */
export const WEB_PLACEHOLDER_PATH = path.resolve(__dirname, '..', 'web-placeholder');

export interface ArchimateConfig {
  readonly region: string;
  /** 스테이지 이름. 리소스 이름과 Environment 태그에 쓰인다. */
  readonly stage: string;
  readonly monthlyBudgetUsd: number;
  /** DynamoDB TTL 속성 이름. 백엔드 #15 확정 */
  readonly ttlAttributeName: string;
  /**
   * Budgets 알림 이메일 (`-c alertEmail=...`). 없으면 Budgets를 만들지 않고 synth 경고만 낸다.
   * 막바지 AWS 배포(7단계)에서는 반드시 넘긴다.
   */
  readonly alertEmail?: string;
  /** 백엔드 레포 절대 경로 (`-c backendPath=...`) */
  readonly backendPath: string;
  /** 프론트 정적 내보내기 결과물 절대 경로 (`-c webAssetPath=...`) */
  readonly webAssetPath: string;
  /**
   * 실제로 S3에 올릴 폴더. `webAssetPath`에 index.html이 있으면 그 폴더,
   * 없으면 레포 안의 플레이스홀더(`web-placeholder/`)다.
   */
  readonly webSourcePath: string;
  readonly bedrockModelIds: typeof BEDROCK_MODEL_IDS;
  readonly bedrockFoundationModelIds: typeof BEDROCK_FOUNDATION_MODEL_IDS;
  /** Lambda 코드 출처 (`-c lambdaCode=stub|backend`, 기본 stub) */
  readonly lambdaCodeSource: LambdaCodeSource;
  /**
   * Lambda 코드 폴더(`archimate/` 패키지의 부모). stub이면 `lambda-stub/`, backend이면 `<backendPath>/src`.
   * pip 의존성 번들은 6단계에서 추가한다.
   */
  readonly lambdaCodePath: string;
  /** LLM 제공자 (`-c llmProvider=bedrock|mock`, 기본 bedrock) */
  readonly llmProvider: string;
}

const STAGE_PATTERN = /^[a-z][a-z0-9-]{0,14}$/;
/** 아주 단순한 형식 검사. 잘못된 주소가 배포 단계에서야 발견되지 않게 한다. */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function readString(app: App, key: string): string | undefined {
  const value = app.node.tryGetContext(key);
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return String(value);
}

/** CDK context(`-c 키=값`)에서 설정을 읽는다. 경로는 IaC 레포 루트(현재 작업 폴더) 기준으로 해석한다. */
export function loadConfig(app: App): ArchimateConfig {
  const stage = readString(app, 'stage') ?? DEFAULT_STAGE;
  if (!STAGE_PATTERN.test(stage)) {
    throw new Error(
      `stage "${stage}"는 소문자로 시작하고 소문자·숫자·하이픈만 쓸 수 있으며 15자 이하여야 합니다.`,
    );
  }

  const lambdaCodeSource = readString(app, 'lambdaCode') ?? 'stub';
  if (lambdaCodeSource !== 'stub' && lambdaCodeSource !== 'backend') {
    throw new Error(`lambdaCode "${lambdaCodeSource}"는 stub 또는 backend만 쓸 수 있습니다.`);
  }
  const alertEmail = readString(app, 'alertEmail');
  if (alertEmail !== undefined && !EMAIL_PATTERN.test(alertEmail)) {
    throw new Error(`alertEmail "${alertEmail}"는 이메일 주소 형식이 아닙니다.`);
  }
  const llmProvider = readString(app, 'llmProvider') ?? DEFAULT_LLM_PROVIDER;
  if (!(LLM_PROVIDERS as readonly string[]).includes(llmProvider)) {
    throw new Error(`llmProvider "${llmProvider}"는 ${LLM_PROVIDERS.join(' 또는 ')}만 쓸 수 있습니다.`);
  }
  const backendPath = path.resolve(readString(app, 'backendPath') ?? '../ArchiMate-Backend');
  const webAssetPath = path.resolve(readString(app, 'webAssetPath') ?? '../ArchiMate-Frontend/out');

  return {
    region: REGION,
    stage,
    monthlyBudgetUsd: MONTHLY_BUDGET_USD,
    ttlAttributeName: TTL_ATTRIBUTE_NAME,
    alertEmail,
    backendPath,
    webAssetPath,
    webSourcePath: fs.existsSync(path.join(webAssetPath, 'index.html')) ? webAssetPath : WEB_PLACEHOLDER_PATH,
    bedrockModelIds: BEDROCK_MODEL_IDS,
    bedrockFoundationModelIds: BEDROCK_FOUNDATION_MODEL_IDS,
    lambdaCodeSource,
    lambdaCodePath: lambdaCodeSource === 'backend' ? path.join(backendPath, 'src') : LAMBDA_STUB_PATH,
    llmProvider,
  };
}

/**
 * 리소스 이름 규칙: `archimate-{env}-{서비스}-{용도}` [conventions 11번]
 * 예) resourceName('demo', 'dynamodb', 'designs') → 'archimate-demo-dynamodb-designs'
 * 이름을 코드에 직접 적지 말고 항상 이 함수로 만든다.
 */
export function resourceName(stage: string, service: string, purpose: string): string {
  const parts = [stage, service, purpose];
  for (const part of parts) {
    if (!/^[a-z0-9-]+$/.test(part)) {
      throw new Error(`리소스 이름 조각 "${part}"에는 소문자·숫자·하이픈만 쓸 수 있습니다.`);
    }
  }
  return ['archimate', ...parts].join('-');
}

/** 스택 이름: `archimate-{env}` */
export function stackName(stage: string): string {
  return `archimate-${stage}`;
}
