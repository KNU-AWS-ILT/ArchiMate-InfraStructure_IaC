import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import {
  OAuthScope,
  UserPool,
  UserPoolClient,
  UserPoolClientIdentityProvider,
  UserPoolDomain,
} from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { ArchimateConfig, AUTH_CALLBACK_PATH, LOCAL_WEB_URL, resourceName } from './config';

export interface AuthProps {
  readonly config: ArchimateConfig;
}

/**
 * 인증: Cognito User Pool + 호스팅 로그인 도메인 + 앱 클라이언트. (MVP_Task.md 3-2, IaC #4 HJTN 결정)
 *
 * 결정 내용:
 *  - 로그인 방식: Cognito 호스팅 로그인 페이지 (프론트가 Authorization code 흐름으로 이동)
 *  - 로그인 아이디: 이메일만. 직접 가입 없음. 팀 계정 1개는 배포 후 CLI로 만든다 (README 참고).
 *    계정을 CDK로 만들지 않는 이유: 비밀번호가 CloudFormation 템플릿에 남기 때문이다.
 *  - 앱 클라이언트: 시크릿 없음, Authorization code grant만(implicit 끔), 범위 openid·email·profile, IdP는 Cognito만.
 *  - 돌아올 주소(callback): 로컬(http://localhost:3000)과 CloudFront 주소의 `/auth/callback/` (IaC #4 HJTN 11-27).
 *    처음 등록한 `/`도 남겨 둔다 (1차 배포 로그인 확인에 쓴 주소).
 *  - 로그아웃 주소(logout): 로컬과 CloudFront 주소의 `/`.
 *
 * 만드는 순서(순환 참조를 피하려고):
 *  API Gateway의 Authorizer는 User Pool만 쓰고, CloudFront는 API Gateway를 쓰고, 앱 클라이언트는 CloudFront 주소를 쓴다.
 *  그래서 User Pool과 도메인은 여기서 먼저 만들고, 앱 클라이언트는 Web을 만든 뒤 `addWebClient()`로 만든다.
 *
 * API Gateway의 Cognito Authorizer는 ID 토큰을 받는다. 프론트는 ID 토큰을 Authorization 헤더에 넣는다.
 * (Bearer 접두사가 필요한지는 배포 후 확인한다.)
 *
 * 명세에 없는 설정(비밀번호 정책, MFA, 토큰 유효 시간, 이메일 발송 방식 등)은 CDK·Cognito 기본값 그대로 둔다.
 */
export class Auth extends Construct {
  public readonly userPool: UserPool;
  /** 호스팅 로그인 도메인 (Cognito 접두사 도메인) */
  public readonly domain: UserPoolDomain;
  /** 호스팅 로그인 도메인 전체 주소 (https:// 없음). 예: archimate-demo-knu.auth.ap-southeast-2.amazoncognito.com */
  public readonly domainName: string;

  private client?: UserPoolClient;
  private readonly stage: string;

  constructor(scope: Construct, id: string, props: AuthProps) {
    super(scope, id);
    const { stage, cognitoDomainPrefix } = props.config;
    this.stage = stage;

    this.userPool = new UserPool(this, 'UserPool', {
      userPoolName: resourceName(stage, 'cognito', 'users'),
      // 로그인 아이디는 이메일만. (사용자 이름으로는 로그인할 수 없다)
      signInAliases: { email: true },
      // 직접 가입 없음. 사용자는 관리자(팀)만 만든다.
      selfSignUpEnabled: false,
      // 이메일을 자동으로 확인 대상에 넣는다.
      autoVerify: { email: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.domain = new UserPoolDomain(this, 'Domain', {
      userPool: this.userPool,
      cognitoDomain: { domainPrefix: cognitoDomainPrefix },
    });
    this.domainName = `${cognitoDomainPrefix}.auth.${Stack.of(this).region}.amazoncognito.com`;
  }

  /** 앱 클라이언트. `addWebClient()`를 부른 뒤에만 쓸 수 있다. */
  public get userPoolClient(): UserPoolClient {
    if (!this.client) {
      throw new Error('앱 클라이언트가 아직 없습니다. Web을 만든 뒤 auth.addWebClient()를 먼저 부르세요.');
    }
    return this.client;
  }

  /**
   * SPA용 앱 클라이언트를 만든다. CloudFront 주소를 callback·logout 주소에 넣어야 해서 Web 다음에 부른다.
   * @param cloudFrontDomainName 같은 스택 CloudFront 배포의 도메인 이름 (distribution.distributionDomainName)
   */
  public addWebClient(cloudFrontDomainName: string): UserPoolClient {
    if (this.client) {
      throw new Error('앱 클라이언트는 한 번만 만들 수 있습니다.');
    }
    const webUrls = [LOCAL_WEB_URL, `https://${cloudFrontDomainName}/`];
    const callbackUrls = [...webUrls, ...webUrls.map((url) => `${url}${AUTH_CALLBACK_PATH}`)];

    this.client = new UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: resourceName(this.stage, 'cognito', 'web'),
      // SPA는 브라우저에 secret을 둘 수 없으므로 generateSecret을 끈다.
      generateSecret: false,
      oAuth: {
        // Authorization code grant만 쓴다. implicit은 끈다.
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls: webUrls,
      },
      // 로그인 제공자는 Cognito(이메일·비밀번호)뿐이다.
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
    });
    return this.client;
  }
}
