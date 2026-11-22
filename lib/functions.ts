import { ArnFormat, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import {
  ArchimateConfig,
  LAMBDA_HANDLERS,
  LAMBDA_TIMEOUT_SECONDS,
  TABLE_ENV_VARS,
  resourceName,
} from './config';
import { DataTables } from './data';

export interface FunctionsProps {
  readonly config: ArchimateConfig;
  readonly data: DataTables;
}

/**
 * Lambda 3개. (MVP_Task.md 3-3, 백엔드 #15, 백엔드 #7)
 *
 * 공통: Python 3.12, ARM64, 로그 보존 2주(삭제 정책 DESTROY).
 * 코드는 `config.lambdaCodePath`에서 묶는다. 지금은 IaC 레포의 더미(lambda-stub)이고,
 * `-c lambdaCode=backend`로 백엔드 레포 `src/`로 바꾼다. (pip 의존성 번들은 6단계)
 * 메모리는 명세가 없어 Lambda 기본값(128MB)이다.
 * EventBridge 스케줄은 3-6에서 만든다.
 */
export class Functions extends Construct {
  /** 설계 생성. POST 접수, 비동기 생성, jobs·guide 조회까지 처리한다 */
  public readonly generate: LambdaFunction;
  /** 노드 설명 */
  public readonly explain: LambdaFunction;
  /** 단가 동기화 */
  public readonly syncPrices: LambdaFunction;

  constructor(scope: Construct, id: string, props: FunctionsProps) {
    super(scope, id);
    const { config, data } = props;
    const { stage } = config;

    const code = Code.fromAsset(config.lambdaCodePath, { exclude: ['__pycache__', '*.pyc'] });

    const createFunction = (
      constructId: string,
      purpose: string,
      handler: string,
      timeoutSeconds: number,
      environment: Record<string, string>,
    ): LambdaFunction => {
      const functionName = resourceName(stage, 'lambda', purpose);
      return new LambdaFunction(this, constructId, {
        functionName,
        runtime: Runtime.PYTHON_3_12,
        architecture: Architecture.ARM_64,
        handler,
        code,
        timeout: Duration.seconds(timeoutSeconds),
        environment,
        logGroup: new LogGroup(this, `${constructId}Logs`, {
          logGroupName: `/aws/lambda/${functionName}`,
          retention: RetentionDays.TWO_WEEKS,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      });
    };

    // 설계 생성: 환경 변수 LLM_PROVIDER, LLM_MODEL
    // 기한 관련 환경 변수(LLM_GENERATION_DEADLINE_S 등)는 넣지 않는다. 백엔드 기본값을 쓴다. (백엔드 #15)
    //
    // EXPLANATIONS_TABLE은 이름만 넘기고 권한은 주지 않는다.
    // 백엔드 storage/dynamodb.py가 시작할 때 DESIGNS_TABLE과 EXPLANATIONS_TABLE을 둘 다 읽기 때문에 환경 변수는 필요하지만,
    // generate가 explanations 테이블을 읽고 쓰지는 않는다. (백엔드 #15 권한표: generate는 explanations 권한 없음, PR #26)
    this.generate = createFunction(
      'Generate',
      'generate',
      LAMBDA_HANDLERS.generate,
      LAMBDA_TIMEOUT_SECONDS.generate,
      {
        [TABLE_ENV_VARS.designs]: data.designs.tableName,
        [TABLE_ENV_VARS.prices]: data.prices.tableName,
        [TABLE_ENV_VARS.explanations]: data.explanations.tableName,
        LLM_PROVIDER: config.llmProvider,
        LLM_MODEL: config.bedrockModelIds.design,
      },
    );
    data.designs.grantReadWriteData(this.generate);
    data.prices.grantReadData(this.generate);
    // explanations 권한은 일부러 주지 않는다. (위 설명 참고)

    // 자기 자신 비동기 호출 권한. POST가 jobId를 저장한 뒤 같은 함수를 다시 호출한다. (백엔드 #7)
    // grantInvoke(자기 자신)는 역할 → 정책 → 함수 순환 참조가 생기므로, 함수 이름으로 ARN을 직접 만든다.
    // 함수 이름이 resourceName()으로 고정돼 있어서 가능하다.
    this.generate.addToRolePolicy(
      new PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          Stack.of(this).formatArn({
            service: 'lambda',
            resource: 'function',
            resourceName: resourceName(stage, 'lambda', 'generate'),
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // 비동기 호출 재시도 끔. 백엔드 코드가 안에서 재시도하므로, AWS가 실패한 호출을 다시 실행하면
    // LLM 호출이 중복돼 비용이 늘어난다. (Lambda 비동기 호출의 기본값은 실패 시 2회 재시도)
    // (백엔드 #15에서 syd348 동의, 확정)
    this.generate.configureAsyncInvoke({ retryAttempts: 0 });

    // 노드 설명: 환경 변수 LLM_PROVIDER, LLM_EXPLAIN_MODEL. prices 권한 없음.
    this.explain = createFunction(
      'Explain',
      'explain',
      LAMBDA_HANDLERS.explain,
      LAMBDA_TIMEOUT_SECONDS.explain,
      {
        [TABLE_ENV_VARS.designs]: data.designs.tableName,
        [TABLE_ENV_VARS.explanations]: data.explanations.tableName,
        LLM_PROVIDER: config.llmProvider,
        LLM_EXPLAIN_MODEL: config.bedrockModelIds.explain,
      },
    );
    data.designs.grantReadData(this.explain);
    data.explanations.grantReadWriteData(this.explain);

    // 단가 동기화: prices 쓰기만. LLM 환경 변수 없음.
    this.syncPrices = createFunction(
      'SyncPrices',
      'sync-prices',
      LAMBDA_HANDLERS.syncPrices,
      LAMBDA_TIMEOUT_SECONDS.syncPrices,
      { [TABLE_ENV_VARS.prices]: data.prices.tableName },
    );
    data.prices.grantWriteData(this.syncPrices);
    // Price List API는 리소스 단위 권한을 지원하지 않아 '*'를 쓴다. 호출 리전(us-east-1)은 코드에서 지정한다.
    this.syncPrices.addToRolePolicy(
      new PolicyStatement({
        actions: ['pricing:GetProducts', 'pricing:DescribeServices', 'pricing:GetAttributeValues'],
        resources: ['*'],
      }),
    );

    // Bedrock 호출 권한. generate와 explain에 `bedrock-mantle:CreateInference` 하나만 허용한다. (백엔드 #15 syd348 정정)
    // 백엔드가 bedrock-mantle의 Messages API를 쓰므로 `bedrock:InvokeModel` 계열 권한과
    // 추론 프로필·파운데이션 모델 ARN은 쓰지 않는다.
    // bedrock-mantle 모델 ARN 형식 확인 후 두 모델로 좁힘 (백엔드 #15 syd348 정정, 실배포 전 확인)
    // 지금은 문서에 모델 리소스 ARN 형식이 없어서 리소스를 '*'로 둔다. 두 함수 모두 모델을 가리지 않고 호출할 수 있다.
    const bedrockStatement = (): PolicyStatement =>
      new PolicyStatement({
        actions: ['bedrock-mantle:CreateInference'],
        resources: ['*'],
      });
    this.generate.addToRolePolicy(bedrockStatement());
    this.explain.addToRolePolicy(bedrockStatement());
  }
}
