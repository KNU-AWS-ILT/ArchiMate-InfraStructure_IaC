import { RemovalPolicy } from 'aws-cdk-lib';
import { UserPool, UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { ArchimateConfig, resourceName } from './config';

export interface AuthProps {
  readonly config: ArchimateConfig;
}

/**
 * 인증: Cognito User Pool + 앱 클라이언트. (Task.md 0장 "인증", MVP_Task.md 3-2)
 *
 * 명세에 있는 것: SPA용 앱 클라이언트(client secret 없음), 삭제 정책 DESTROY, 출력값 2개.
 * 명세에 없는 설정(비밀번호 정책, MFA, 이메일 발송 등)은 CDK 기본값 그대로 둔다.
 *
 * 프론트 회신 대기 (아래 3가지는 정해지기 전까지 CDK 기본값을 쓴다. 정해지면 이 파일을 고친다):
 *   1. 로그인 방식: SDK 직접 로그인 또는 Hosted UI
 *   2. 자가 가입 허용 여부 (현재 기본값: 꺼짐, 관리자만 사용자 생성 가능)
 *   3. 로그인 아이디: 이메일 또는 사용자 이름 (현재 기본값: 사용자 이름)
 *
 * OAuth 기본값(허용 흐름 implicit·code, 콜백 URL https://example.com)은 로그인 방식 결정 후 정리한다.
 */
export class Auth extends Construct {
  public readonly userPool: UserPool;
  public readonly userPoolClient: UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthProps) {
    super(scope, id);
    const { stage } = props.config;

    this.userPool = new UserPool(this, 'UserPool', {
      userPoolName: resourceName(stage, 'cognito', 'users'),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // SPA는 브라우저에 secret을 둘 수 없으므로 generateSecret을 끈다. (CDK 기본값도 false지만 명세라서 명시)
    this.userPoolClient = new UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: resourceName(stage, 'cognito', 'web'),
      generateSecret: false,
    });
  }
}
