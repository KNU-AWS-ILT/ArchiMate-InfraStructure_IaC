import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ArchimateStack } from '../lib/archimate-stack';
import { API_THROTTLE, loadConfig } from '../lib/config';

function synth(context?: Record<string, string>): Template {
  const app = new App({ context });
  const stack = new ArchimateStack(app, 'archimate-demo', { config: loadConfig(app) });
  return Template.fromStack(stack);
}

const template = synth();
type Json = Record<string, any>;

const GENERATE = 'archimate-demo-lambda-generate';
const EXPLAIN = 'archimate-demo-lambda-explain';
const SYNC_PRICES = 'archimate-demo-lambda-sync-prices';

function functionId(name: string): string {
  const found = Object.keys(template.findResources('AWS::Lambda::Function', { Properties: { FunctionName: name } }));
  expect(found).toHaveLength(1);
  return found[0];
}

const resources = Object.entries(template.findResources('AWS::ApiGateway::Resource')) as [string, Json][];

/** API Gateway 리소스의 전체 경로. 루트(`/`)에서 PathPart를 이어 붙인다. */
function fullPath(resourceLogicalId: string): string {
  const entry = resources.find(([id]) => id === resourceLogicalId);
  expect(entry).toBeDefined();
  const { PathPart, ParentId } = entry![1].Properties;
  return ParentId.Ref ? `${fullPath(ParentId.Ref)}/${PathPart}` : `/${PathPart}`;
}

const methods = Object.values(template.findResources('AWS::ApiGateway::Method')) as Json[];

/** `METHOD /경로` → 연결된 Lambda 함수 이름 */
function routes(): Record<string, string> {
  const names: Record<string, string> = {
    [functionId(GENERATE)]: GENERATE,
    [functionId(EXPLAIN)]: EXPLAIN,
    [functionId(SYNC_PRICES)]: SYNC_PRICES,
  };
  const result: Record<string, string> = {};
  for (const method of methods) {
    const uri = JSON.stringify(method.Properties.Integration.Uri);
    const linked = Object.keys(names).filter((id) => uri.includes(`"${id}"`));
    expect(linked).toHaveLength(1);
    result[`${method.Properties.HttpMethod} ${fullPath(method.Properties.ResourceId.Ref)}`] = names[linked[0]];
  }
  return result;
}

describe('API Gateway REST API', () => {
  it('REST API는 1개, 리전 엔드포인트, 이름은 resourceName 규칙이다', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'archimate-demo-apigateway-api',
      EndpointConfiguration: { Types: ['REGIONAL'] },
    });
  });

  it('태그 3종이 붙는다', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Tags: Match.arrayWith([
        { Key: 'Environment', Value: 'demo' },
        { Key: 'Owner', Value: 'infra' },
        { Key: 'Project', Value: 'ArchiMate' },
      ]),
    });
  });

  it('스테이지 이름은 스테이지(demo)와 같다', () => {
    template.hasResourceProperties('AWS::ApiGateway::Stage', { StageName: 'demo' });
  });

  it('스테이지를 바꾸면 이름이 따라간다', () => {
    synth({ stage: 'test' }).hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'archimate-test-apigateway-api',
    });
  });

  it('계정 단위 CloudWatch 로그 역할을 만들지 않는다', () => {
    template.resourceCountIs('AWS::ApiGateway::Account', 0);
  });
});

describe('라우트', () => {
  it('라우트는 4개이고 각각 연결된 Lambda가 맞다', () => {
    expect(routes()).toEqual({
      'POST /api/v1/designs': GENERATE,
      'GET /api/v1/designs/jobs/{jobId}': GENERATE,
      'GET /api/v1/designs/{designId}/guide': GENERATE,
      'GET /api/v1/designs/{designId}/nodes/{nodeId}/explanation': EXPLAIN,
    });
  });

  it('sync_prices는 API에 연결되지 않는다', () => {
    expect(Object.values(routes())).not.toContain(SYNC_PRICES);
    const permissions = Object.values(template.findResources('AWS::Lambda::Permission')) as Json[];
    const syncId = functionId(SYNC_PRICES);
    // sync_prices를 호출할 수 있는 건 EventBridge뿐이다. (API Gateway 권한은 없다)
    const forSync = permissions.filter((p) => JSON.stringify(p.Properties.FunctionName).includes(syncId));
    expect(forSync.map((p) => p.Properties.Principal)).toEqual(['events.amazonaws.com']);
  });

  it('API Gateway가 generate와 explain을 호출할 권한이 있다', () => {
    for (const name of [GENERATE, EXPLAIN]) {
      template.hasResourceProperties('AWS::Lambda::Permission', {
        Action: 'lambda:InvokeFunction',
        Principal: 'apigateway.amazonaws.com',
        FunctionName: { 'Fn::GetAtt': [functionId(name), 'Arn'] },
      });
    }
  });
});

describe('Cognito Authorizer', () => {
  it('Authorizer는 1개이고 3-2의 User Pool을 쓴다', () => {
    template.resourceCountIs('AWS::ApiGateway::Authorizer', 1);
    const userPoolId = Object.keys(template.findResources('AWS::Cognito::UserPool'))[0];
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Name: 'archimate-demo-apigateway-cognito',
      Type: 'COGNITO_USER_POOLS',
      IdentitySource: 'method.request.header.Authorization',
      ProviderARNs: [{ 'Fn::GetAtt': [userPoolId, 'Arn'] }],
    });
  });

  it('모든 라우트에 Authorizer가 적용된다', () => {
    const authorizerId = Object.keys(template.findResources('AWS::ApiGateway::Authorizer'))[0];
    expect(methods).toHaveLength(4);
    for (const method of methods) {
      expect(method.Properties.AuthorizationType).toBe('COGNITO_USER_POOLS');
      expect(method.Properties.AuthorizerId).toEqual({ Ref: authorizerId });
    }
  });
});

describe('통합 방식', () => {
  it('모든 라우트가 Lambda 프록시 통합(AWS_PROXY)이다', () => {
    for (const method of methods) {
      expect(method.Properties.Integration.Type).toBe('AWS_PROXY');
      expect(method.Properties.Integration.IntegrationHttpMethod).toBe('POST');
    }
  });

  it('비동기(Event) 통합을 쓰지 않는다', () => {
    for (const method of methods) {
      expect(JSON.stringify(method.Properties.Integration)).not.toContain('X-Amz-Invocation-Type');
    }
  });
});

describe('CORS', () => {
  it('OPTIONS 메서드가 없다', () => {
    expect(methods.map((m) => m.Properties.HttpMethod)).not.toContain('OPTIONS');
    expect(methods.map((m) => m.Properties.HttpMethod).sort()).toEqual(['GET', 'GET', 'GET', 'POST']);
  });
});

describe('스테이지 스로틀', () => {
  it('config의 임시값이 모든 경로·메서드에 적용된다 (명세 없음, 임시값)', () => {
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: Match.arrayWith([
        Match.objectLike({
          HttpMethod: '*',
          ResourcePath: '/*',
          ThrottlingRateLimit: API_THROTTLE.rateLimit,
          ThrottlingBurstLimit: API_THROTTLE.burstLimit,
        }),
      ]),
    });
  });
});

describe('게이트웨이 응답 (API Gateway가 직접 보내는 오류)', () => {
  const gatewayResponses = Object.values(template.findResources('AWS::ApiGateway::GatewayResponse')) as Json[];

  const byType = (type: string): Json => {
    const found = gatewayResponses.filter((r) => r.Properties.ResponseType === type);
    expect(found).toHaveLength(1);
    return found[0].Properties;
  };
  const bodyOf = (type: string): Json => JSON.parse(byType(type).ResponseTemplates['application/json']);

  // [응답 유형, 상태 코드(없으면 원래 코드 유지), code, retryable]
  const expected: [string, string | undefined, string, boolean][] = [
    ['UNAUTHORIZED', '401', 'UNAUTHORIZED', false],
    ['ACCESS_DENIED', '403', 'UNAUTHORIZED', false], // 401·403만 UNAUTHORIZED, 백엔드 FastAPI와 같음 (백엔드 #15)
    ['THROTTLED', '429', 'RATE_LIMITED', true],
    ['INTEGRATION_TIMEOUT', '504', 'LLM_TIMEOUT', true], // 인프라 매핑, 백엔드 #15 확인 완료
    ['DEFAULT_4XX', undefined, 'INVALID_REQUEST', false], // 인프라 매핑, 백엔드 #15 확인 완료
    ['DEFAULT_5XX', undefined, 'INTERNAL_ERROR', true],
  ];

  it('게이트웨이 응답은 6개다', () => {
    template.resourceCountIs('AWS::ApiGateway::GatewayResponse', 6);
    expect(gatewayResponses.map((r) => r.Properties.ResponseType).sort()).toEqual(
      expected.map(([type]) => type).sort(),
    );
  });

  it.each(expected)('%s: 상태 코드 %s, code %s, retryable %s', (type, statusCode, code, retryable) => {
    const properties = byType(type);
    expect(properties.StatusCode).toBe(statusCode);
    const body = bodyOf(type);
    expect(body.code).toBe(code);
    expect(body.retryable).toBe(retryable);
  });

  it.each(expected)('%s: 본문은 { code, message, retryable, requestId }이고 requestId는 $context.requestId다', (type) => {
    const body = bodyOf(type);
    expect(Object.keys(body).sort()).toEqual(['code', 'message', 'requestId', 'retryable']);
    expect(body.requestId).toBe('$context.requestId');
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
  });

  it('모든 응답의 Content-Type은 application/json이다', () => {
    for (const response of gatewayResponses) {
      expect(response.Properties.ResponseParameters['gatewayresponse.header.Content-Type']).toBe(
        "'application/json'",
      );
    }
  });

  it('모든 게이트웨이 응답이 이 REST API에 붙는다', () => {
    const restApiId = Object.keys(template.findResources('AWS::ApiGateway::RestApi'))[0];
    for (const response of gatewayResponses) {
      expect(response.Properties.RestApiId).toEqual({ Ref: restApiId });
    }
  });
});

