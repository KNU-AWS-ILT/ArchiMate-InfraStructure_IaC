import * as path from 'path';
import { App } from 'aws-cdk-lib';

/** 서울 리전. (Price List API만 us-east-1을 쓰며, 해당 Lambda 코드에서 지정한다) */
export const REGION = 'ap-northeast-2';

/** 월 예산(USD). Budgets 알람 기준. */
export const MONTHLY_BUDGET_USD = 30;

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
 * Bedrock 모델 ID (임시값).
 * 서울 리전에서 직접 호출되는지, `apac.` 같은 추론 프로필이 필요한지 백엔드(AI)에 확인 중이다. (Task.md Q3)
 */
export const BEDROCK_MODEL_IDS = {
  design: 'anthropic.claude-opus-5-5',
  explain: 'anthropic.claude-haiku-5-5',
} as const;

export interface ArchimateConfig {
  readonly region: string;
  /** 스테이지 이름. 리소스 이름과 Environment 태그에 쓰인다. */
  readonly stage: string;
  readonly monthlyBudgetUsd: number;
  /** DynamoDB TTL 속성 이름. 백엔드 #15 확정 */
  readonly ttlAttributeName: string;
  /** Budgets 알림 이메일 (`-c alertEmail=...`). Budgets를 만들 때 필수로 바꾼다. */
  readonly alertEmail?: string;
  /** 백엔드 레포 절대 경로 (`-c backendPath=...`) */
  readonly backendPath: string;
  /** 프론트 정적 내보내기 결과물 절대 경로 (`-c webAssetPath=...`) */
  readonly webAssetPath: string;
  readonly bedrockModelIds: typeof BEDROCK_MODEL_IDS;
}

const STAGE_PATTERN = /^[a-z][a-z0-9-]{0,14}$/;

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

  return {
    region: REGION,
    stage,
    monthlyBudgetUsd: MONTHLY_BUDGET_USD,
    ttlAttributeName: TTL_ATTRIBUTE_NAME,
    alertEmail: readString(app, 'alertEmail'),
    backendPath: path.resolve(readString(app, 'backendPath') ?? '../ArchiMate-Backend'),
    webAssetPath: path.resolve(readString(app, 'webAssetPath') ?? '../ArchiMate-Frontend/out'),
    bedrockModelIds: BEDROCK_MODEL_IDS,
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
