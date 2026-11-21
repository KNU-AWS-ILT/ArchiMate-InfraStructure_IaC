import { CfnOutput, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Auth } from './auth';
import { ArchimateConfig, TAG_OWNER, TAG_PROJECT } from './config';
import { DataTables } from './data';
import { Functions } from './functions';

export interface ArchimateStackProps extends StackProps {
  readonly config: ArchimateConfig;
}

/**
 * ArchiMate 서버리스 스택.
 * 지금은 DynamoDB 3개, Cognito, Lambda 3개가 있다. API Gateway·CloudFront·EventBridge·Budgets는 다음 단계에서 추가한다.
 */
export class ArchimateStack extends Stack {
  /** Lambda에 권한과 테이블 이름을 넘길 때 쓴다 (3-3단계) */
  public readonly data: DataTables;
  /** API Gateway Authorizer에 연결할 때 쓴다 (3-4단계) */
  public readonly auth: Auth;
  /** API Gateway 라우트와 EventBridge 스케줄에 연결할 때 쓴다 (3-4, 3-6단계) */
  public readonly functions: Functions;

  constructor(scope: Construct, id: string, props: ArchimateStackProps) {
    super(scope, id, props);

    this.data = new DataTables(this, 'Data', { config: props.config });
    this.auth = new Auth(this, 'Auth', { config: props.config });
    this.functions = new Functions(this, 'Functions', { config: props.config, data: this.data });

    // 프론트에 전달하는 공개 값. 출력 이름은 camelCase. (프론트 전달 방식은 협의 필요, Task.md 3-3)
    new CfnOutput(this, 'userPoolId', {
      value: this.auth.userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });
    new CfnOutput(this, 'userPoolClientId', {
      value: this.auth.userPoolClient.userPoolClientId,
      description: 'Cognito 앱 클라이언트 ID (SPA용, secret 없음)',
    });

    // 스택 안의 모든 리소스에 태그가 전파된다. [conventions 11번]
    Tags.of(this).add('Project', TAG_PROJECT);
    Tags.of(this).add('Environment', props.config.stage);
    Tags.of(this).add('Owner', TAG_OWNER);
  }
}
