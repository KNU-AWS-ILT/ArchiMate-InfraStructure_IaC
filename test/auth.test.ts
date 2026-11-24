import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ArchimateStack } from '../lib/archimate-stack';
import { Auth } from '../lib/auth';
import { LOCAL_WEB_URL, loadConfig } from '../lib/config';

type Json = Record<string, any>;

/** bin/archimate-infra.ts처럼 리전을 지정하면 region·cognitoDomain 출력이 토큰이 아닌 실제 값으로 나온다. */
function synth(context?: Record<string, string>, withRegion = false): Template {
  const app = new App({ context });
  const config = loadConfig(app);
  const stack = new ArchimateStack(app, 'archimate-demo', {
    config,
    ...(withRegion ? { env: { region: config.region } } : {}),
  });
  return Template.fromStack(stack);
}

const template = synth();
const regional = synth(undefined, true);

const only = (t: Template, type: string): [string, Json] => {
  const found = Object.entries(t.findResources(type));
  expect(found).toHaveLength(1);
  return [found[0][0], found[0][1] as Json];
};

const [userPoolId, userPool] = only(template, 'AWS::Cognito::UserPool');
const [, domain] = only(template, 'AWS::Cognito::UserPoolDomain');
const [clientId, client] = only(template, 'AWS::Cognito::UserPoolClient');
const [distributionId, distribution] = only(template, 'AWS::CloudFront::Distribution');

describe('Cognito User Pool', () => {
  it('User Pool은 1개, 이름은 resourceName 규칙', () => {
    expect(userPool.Properties.UserPoolName).toBe('archimate-demo-cognito-users');
  });

  it('로그인 아이디는 이메일만이다 (사용자 이름·별칭 로그인 없음)', () => {
    expect(userPool.Properties.UsernameAttributes).toEqual(['email']);
    expect(userPool.Properties.AliasAttributes).toBeUndefined();
  });

  it('직접 가입이 없다 (관리자만 사용자를 만들 수 있다)', () => {
    expect(userPool.Properties.AdminCreateUserConfig).toEqual({ AllowAdminCreateUserOnly: true });
  });

  it('이메일을 자동 확인 대상에 넣는다', () => {
    expect(userPool.Properties.AutoVerifiedAttributes).toEqual(['email']);
  });

  it('삭제 정책은 DESTROY(Delete)다', () => {
    expect(userPool.DeletionPolicy).toBe('Delete');
    expect(userPool.UpdateReplacePolicy).toBe('Delete');
  });

  it('태그 3종이 붙는다', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolTags: Match.objectLike({ Project: 'ArchiMate', Environment: 'demo', Owner: 'infra' }),
    });
  });

  it('팀 계정은 CDK로 만들지 않는다 (비밀번호가 템플릿에 남기 때문)', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolUser', 0);
    const text = JSON.stringify(template.toJSON());
    expect(text).not.toContain('TemporaryPassword');
    expect(text).not.toContain('"Password"');
  });

  it('스테이지를 바꾸면 이름이 따라간다', () => {
    synth({ stage: 'test' }).hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'archimate-test-cognito-users',
    });
  });
});

describe('Cognito 호스팅 로그인 도메인', () => {
  it('접두사 도메인은 1개이고 기본값은 archimate-demo-knu다', () => {
    expect(domain.Properties.Domain).toBe('archimate-demo-knu');
    expect(domain.Properties.UserPoolId).toEqual({ Ref: userPoolId });
  });

  it('직접 만든 도메인(CustomDomainConfig)이나 인증서를 쓰지 않는다', () => {
    expect(domain.Properties.CustomDomainConfig).toBeUndefined();
  });

  it('삭제 정책이 Retain이 아니다 (cdk destroy로 지워진다)', () => {
    expect(domain.DeletionPolicy).not.toBe('Retain');
  });

  it('-c cognitoDomainPrefix로 바꿀 수 있다', () => {
    synth({ cognitoDomainPrefix: 'archimate-team4-web' }).hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'archimate-team4-web',
    });
  });

  it('스테이지를 바꾸면 기본 접두사도 따라간다 (스테이지끼리 겹치지 않음)', () => {
    synth({ stage: 'test' }).hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: 'archimate-test-knu' });
  });
});

describe('Cognito 앱 클라이언트', () => {
  it('앱 클라이언트는 1개이고 이름은 resourceName 규칙, 시크릿이 없다', () => {
    expect(client.Properties.ClientName).toBe('archimate-demo-cognito-web');
    expect(client.Properties.GenerateSecret).toBe(false);
    expect(client.Properties.UserPoolId).toEqual({ Ref: userPoolId });
  });

  it('Authorization code grant만 쓴다 (implicit 없음)', () => {
    expect(client.Properties.AllowedOAuthFlows).toEqual(['code']);
    expect(client.Properties.AllowedOAuthFlowsUserPoolClient).toBe(true);
  });

  it('범위는 openid·email·profile뿐이다', () => {
    expect([...client.Properties.AllowedOAuthScopes].sort()).toEqual(['email', 'openid', 'profile']);
  });

  it('로그인 제공자는 COGNITO뿐이다', () => {
    expect(client.Properties.SupportedIdentityProviders).toEqual(['COGNITO']);
  });

  it('callback과 logout 주소는 같고, 로컬과 CloudFront 주소 둘 다다', () => {
    const cloudFront = { 'Fn::Join': ['', ['https://', { 'Fn::GetAtt': [distributionId, 'DomainName'] }, '/']] };
    expect(LOCAL_WEB_URL).toBe('http://localhost:3000/');
    expect(client.Properties.CallbackURLs).toEqual([LOCAL_WEB_URL, cloudFront]);
    expect(client.Properties.LogoutURLs).toEqual([LOCAL_WEB_URL, cloudFront]);
  });

  it('CloudFront 주소는 같은 스택의 배포를 참조한다 (순환 참조 없이 합성됨)', () => {
    // 이 파일이 합성에 성공했다는 것 자체가 순환이 없다는 증거다. 방향도 확인한다:
    // 앱 클라이언트 → CloudFront는 참조하지만, CloudFront 배포는 앱 클라이언트를 참조하지 않는다.
    expect(JSON.stringify(client.Properties.CallbackURLs)).toContain(distributionId);
    expect(JSON.stringify(distribution)).not.toContain(clientId);
  });

  it('API Gateway Authorizer는 User Pool만 쓰고 앱 클라이언트에 의존하지 않는다', () => {
    const authorizers = Object.values(template.findResources('AWS::ApiGateway::Authorizer')) as Json[];
    expect(authorizers).toHaveLength(1);
    expect(JSON.stringify(authorizers[0])).toContain(userPoolId);
    expect(JSON.stringify(authorizers[0])).not.toContain(clientId);
  });
});

describe('출력값 (프론트 환경 변수 4개용)', () => {
  const outputs = regional.toJSON().Outputs as Json;

  it('userPoolId·userPoolClientId·region·cognitoDomain과 cloudFrontUrl이 있다', () => {
    expect(Object.keys(outputs)).toEqual(
      expect.arrayContaining(['userPoolId', 'userPoolClientId', 'region', 'cognitoDomain', 'cloudFrontUrl']),
    );
  });

  it('userPoolId, userPoolClientId는 각 리소스를 가리킨다', () => {
    expect(outputs.userPoolId.Value).toEqual({ Ref: userPoolId });
    expect(outputs.userPoolClientId.Value).toEqual({ Ref: clientId });
  });

  it('region은 서울이다', () => {
    expect(outputs.region.Value).toBe('ap-northeast-2');
  });

  it('cognitoDomain은 https:// 없는 전체 주소다', () => {
    expect(outputs.cognitoDomain.Value).toBe('archimate-demo-knu.auth.ap-northeast-2.amazoncognito.com');
    expect(outputs.cognitoDomain.Value).not.toMatch(/^https?:/);
  });

  it('접두사를 바꾸면 cognitoDomain도 따라간다', () => {
    const changed = synth({ cognitoDomainPrefix: 'archimate-team4-web' }, true).toJSON().Outputs as Json;
    expect(changed.cognitoDomain.Value).toBe('archimate-team4-web.auth.ap-northeast-2.amazoncognito.com');
  });

  it('프론트 환경 변수 이름이 출력값 설명에 적혀 있다', () => {
    const description = (name: string): string => outputs[name].Description;
    expect(description('userPoolId')).toContain('NEXT_PUBLIC_COGNITO_USER_POOL_ID');
    expect(description('userPoolClientId')).toContain('NEXT_PUBLIC_COGNITO_CLIENT_ID');
    expect(description('region')).toContain('NEXT_PUBLIC_COGNITO_REGION');
    expect(description('cognitoDomain')).toContain('NEXT_PUBLIC_COGNITO_DOMAIN');
  });
});

describe('Auth 구성 요소', () => {
  const build = (): Auth => {
    const app = new App();
    return new Auth(new Stack(app, 'x'), 'Auth', { config: loadConfig(app) });
  };

  it('앱 클라이언트는 addWebClient() 전에는 쓸 수 없다', () => {
    expect(() => build().userPoolClient).toThrow();
  });

  it('addWebClient() 뒤에는 쓸 수 있고, 두 번 만들 수는 없다', () => {
    const auth = build();
    const created = auth.addWebClient('d111111abcdef8.cloudfront.net');
    expect(auth.userPoolClient).toBe(created);
    expect(() => auth.addWebClient('d111111abcdef8.cloudfront.net')).toThrow();
  });
});
