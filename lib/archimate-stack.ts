import { CfnOutput, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Auth } from './auth';
import { ArchimateConfig, TAG_OWNER, TAG_PROJECT } from './config';
import { Api } from './api';
import { Budget } from './budget';
import { DataTables } from './data';
import { Functions } from './functions';
import { PriceSyncSchedule } from './schedule';
import { Web, addWebOutputs } from './web';

export interface ArchimateStackProps extends StackProps {
  readonly config: ArchimateConfig;
}

/**
 * ArchiMate 서버리스 스택.
 * DynamoDB 3개, Cognito, Lambda 3개, API Gateway, S3 + CloudFront, EventBridge 스케줄, Budgets가 있다.
 */
export class ArchimateStack extends Stack {
  /** Lambda에 권한과 테이블 이름을 넘길 때 쓴다 (3-3단계) */
  public readonly data: DataTables;
  /** API Gateway Authorizer에 연결할 때 쓴다 (3-4단계) */
  public readonly auth: Auth;
  /** API Gateway 라우트와 EventBridge 스케줄에 연결할 때 쓴다 (3-4, 3-6단계) */
  public readonly functions: Functions;
  /** CloudFront `/api/*` 동작의 오리진으로 연결할 때 쓴다 (3-5단계) */
  public readonly api: Api;
  public readonly web: Web;
  public readonly schedule: PriceSyncSchedule;
  public readonly budget: Budget;

  constructor(scope: Construct, id: string, props: ArchimateStackProps) {
    super(scope, id, props);

    this.data = new DataTables(this, 'Data', { config: props.config });
    this.auth = new Auth(this, 'Auth', { config: props.config });
    this.functions = new Functions(this, 'Functions', { config: props.config, data: this.data });
    this.api = new Api(this, 'Api', { config: props.config, auth: this.auth, functions: this.functions });
    this.web = new Web(this, 'Web', { config: props.config, api: this.api });
    addWebOutputs(this, this.web);
    // 앱 클라이언트는 CloudFront 주소를 callback·logout 주소로 쓰므로 Web 다음에 만든다. (순환 참조 방지)
    this.auth.addWebClient(this.web.distribution.distributionDomainName);
    this.schedule = new PriceSyncSchedule(this, 'Schedule', { config: props.config, functions: this.functions });
    this.budget = new Budget(this, 'Budget', { config: props.config });

    // 프론트에 전달하는 공개 값. 출력 이름은 camelCase. (cloudFrontUrl은 addWebOutputs에서 이미 만든다)
    // 1차 배포 후 이 값을 프론트의 환경 변수 4개에 넣는다. (IaC #4, HJTN)
    //   NEXT_PUBLIC_COGNITO_USER_POOL_ID = userPoolId
    //   NEXT_PUBLIC_COGNITO_CLIENT_ID    = userPoolClientId
    //   NEXT_PUBLIC_COGNITO_REGION       = region
    //   NEXT_PUBLIC_COGNITO_DOMAIN       = cognitoDomain
    new CfnOutput(this, 'userPoolId', {
      value: this.auth.userPool.userPoolId,
      description: 'Cognito User Pool ID → NEXT_PUBLIC_COGNITO_USER_POOL_ID',
    });
    new CfnOutput(this, 'userPoolClientId', {
      value: this.auth.userPoolClient.userPoolClientId,
      description: 'Cognito 앱 클라이언트 ID (SPA용, secret 없음) → NEXT_PUBLIC_COGNITO_CLIENT_ID',
    });
    new CfnOutput(this, 'region', {
      value: this.region,
      description: 'AWS 리전 → NEXT_PUBLIC_COGNITO_REGION',
    });
    new CfnOutput(this, 'cognitoDomain', {
      value: this.auth.domainName,
      description: 'Cognito 호스팅 로그인 도메인 (https:// 없음) → NEXT_PUBLIC_COGNITO_DOMAIN',
    });

    // 스택 안의 모든 리소스에 태그가 전파된다. [conventions 11번]
    Tags.of(this).add('Project', TAG_PROJECT);
    Tags.of(this).add('Environment', props.config.stage);
    Tags.of(this).add('Owner', TAG_OWNER);
  }
}
