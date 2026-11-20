import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ArchimateConfig, TAG_OWNER, TAG_PROJECT } from './config';

export interface ArchimateStackProps extends StackProps {
  readonly config: ArchimateConfig;
}

/**
 * ArchiMate 서버리스 스택.
 * 지금은 빈 스택이다. DynamoDB·Cognito·Lambda·API Gateway·CloudFront·Budgets는 다음 단계에서 추가한다.
 */
export class ArchimateStack extends Stack {
  constructor(scope: Construct, id: string, props: ArchimateStackProps) {
    super(scope, id, props);

    // 스택 안의 모든 리소스에 태그가 전파된다. [conventions 11번]
    Tags.of(this).add('Project', TAG_PROJECT);
    Tags.of(this).add('Environment', props.config.stage);
    Tags.of(this).add('Owner', TAG_OWNER);
  }
}
