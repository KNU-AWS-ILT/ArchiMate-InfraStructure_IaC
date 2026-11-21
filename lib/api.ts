import { Construct } from 'constructs';
import {
  AuthorizationType,
  CognitoUserPoolsAuthorizer,
  EndpointType,
  LambdaIntegration,
  Resource,
  ResponseType,
  RestApi,
} from 'aws-cdk-lib/aws-apigateway';
import { Auth } from './auth';
import { API_THROTTLE, ArchimateConfig, resourceName } from './config';
import { Functions } from './functions';

/**
 * API Gateway가 직접 보내는 오류 응답. 형식은 `{ code, message, retryable, requestId }` (백엔드 #7 에러표).
 * 프론트는 code로 화면 문구를 정하므로 message는 화면에 쓰이지 않는다.
 *
 * statusCode를 비운 응답(DEFAULT_4XX, DEFAULT_5XX)은 API Gateway가 원래 정한 상태 코드를 그대로 쓴다.
 */
interface GatewayError {
  readonly id: string;
  readonly type: ResponseType;
  readonly statusCode?: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export const GATEWAY_ERRORS: readonly GatewayError[] = [
  {
    id: 'Unauthorized',
    type: ResponseType.UNAUTHORIZED,
    statusCode: '401',
    code: 'UNAUTHORIZED',
    message: '로그인이 필요해요.',
    retryable: false,
  },
  {
    id: 'Throttled',
    type: ResponseType.THROTTLED,
    statusCode: '429',
    code: 'RATE_LIMITED',
    message: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.',
    retryable: true,
  },
  {
    // 401과 403만 UNAUTHORIZED로 구분한다. 백엔드 FastAPI와 같은 기준이다. (백엔드 #15, dev-sohyeon)
    // 이 403은 ACCESS_DENIED 유형이다. 다른 403(MISSING_AUTHENTICATION_TOKEN 등)은 아래 DEFAULT_4XX로 간다.
    id: 'AccessDenied',
    type: ResponseType.ACCESS_DENIED,
    statusCode: '403',
    code: 'UNAUTHORIZED',
    message: '접근 권한이 없어요.',
    retryable: false,
  },
  {
    // 인프라 매핑, 백엔드 #15 확인 완료 (#7 에러표에는 없음).
    // 통합 시간 초과는 LLM 때문이 아닐 수도 있는데 LLM_TIMEOUT으로 내보낸다.
    id: 'IntegrationTimeout',
    type: ResponseType.INTEGRATION_TIMEOUT,
    statusCode: '504',
    code: 'LLM_TIMEOUT',
    message: '응답 시간이 초과됐어요. 다시 시도해 주세요.',
    retryable: true,
  },
  {
    // 인프라 매핑, 백엔드 #15 확인 완료 (#7 에러표에는 없음).
    // 위에서 따로 정하지 않은 모든 4xx(404, 400, 그리고 ACCESS_DENIED가 아닌 403 등)가 INVALID_REQUEST가 된다.
    id: 'Default4xx',
    type: ResponseType.DEFAULT_4XX,
    code: 'INVALID_REQUEST',
    message: '요청을 처리할 수 없어요.',
    retryable: false,
  },
  {
    id: 'Default5xx',
    type: ResponseType.DEFAULT_5XX,
    code: 'INTERNAL_ERROR',
    message: '서버에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.',
    retryable: true,
  },
];

export interface ApiProps {
  readonly config: ArchimateConfig;
  readonly auth: Auth;
  readonly functions: Functions;
}

/**
 * API Gateway (REST, 리전 엔드포인트). (MVP_Task.md 3-4, 백엔드 #7·#15, 인프라 #3)
 *
 * - 라우트 4개 모두 Lambda 프록시 통합. POST도 Lambda가 직접 `202 { jobId }`를 응답한다. (`Event` 통합 안 씀)
 * - 모든 라우트에 Cognito User Pool Authorizer를 건다. (3-2의 User Pool)
 * - CORS는 설정하지 않는다. CloudFront가 같은 도메인으로 `/api/*`를 넘기므로 필요 없다. (인프라 #3)
 * - CloudFront 연결은 3-5에서 한다. 이 API의 호출 주소는 `/{스테이지 이름}/api/v1/...`이라서,
 *   CloudFront 오리진에 스테이지 경로(`/{stage}`)를 지정해야 `/api/*`가 경로 변경 없이 넘어간다.
 */
export class Api extends Construct {
  public readonly restApi: RestApi;
  public readonly authorizer: CognitoUserPoolsAuthorizer;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const { config, auth, functions } = props;
    const { stage } = config;

    this.restApi = new RestApi(this, 'RestApi', {
      restApiName: resourceName(stage, 'apigateway', 'api'),
      endpointTypes: [EndpointType.REGIONAL],
      // 계정 단위 CloudWatch 로그 역할을 만들지 않는다. (운영 알람·로그는 Budgets만 두기로 한 범위)
      // cdk.json의 flag와 같은 값을 코드에 적어, 테스트와 실제 synth의 결과가 같게 한다.
      cloudWatchRole: false,
      deployOptions: {
        stageName: stage,
        throttlingRateLimit: API_THROTTLE.rateLimit,
        throttlingBurstLimit: API_THROTTLE.burstLimit,
      },
      // defaultCorsPreflightOptions를 쓰지 않는다. (OPTIONS 메서드 없음)
    });

    // Authorization 헤더의 Cognito 토큰을 검증한다. 결과 캐시 시간 등은 CDK 기본값.
    this.authorizer = new CognitoUserPoolsAuthorizer(this, 'Authorizer', {
      authorizerName: resourceName(stage, 'apigateway', 'cognito'),
      cognitoUserPools: [auth.userPool],
    });

    // API Gateway가 직접 보내는 오류 응답도 백엔드와 같은 형식으로 맞춘다.
    // requestId는 응답 본문 템플릿의 $context.requestId로 채운다.
    // X-Request-Id 헤더는 넣지 않는다: API Gateway가 x-amzn-RequestId 헤더를 자동으로 붙이고 본문에도 requestId가 있어 충분하다.
    for (const error of GATEWAY_ERRORS) {
      this.restApi.addGatewayResponse(error.id, {
        type: error.type,
        statusCode: error.statusCode,
        responseHeaders: { 'Content-Type': "'application/json'" },
        templates: {
          'application/json': JSON.stringify({
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            requestId: '$context.requestId',
          }),
        },
      });
    }

    const methodOptions = {
      authorizationType: AuthorizationType.COGNITO,
      authorizer: this.authorizer,
    };
    // LambdaIntegration은 기본이 프록시 통합(AWS_PROXY)이다.
    const generate = new LambdaIntegration(functions.generate);
    const explain = new LambdaIntegration(functions.explain);

    const designs = this.restApi.root.addResource('api').addResource('v1').addResource('designs');
    const addRoute = (resource: Resource, method: string, integration: LambdaIntegration): void => {
      resource.addMethod(method, integration, methodOptions);
    };

    // POST /api/v1/designs → generate (Lambda가 202 { jobId } 응답)
    addRoute(designs, 'POST', generate);
    // GET /api/v1/designs/jobs/{jobId} → generate
    addRoute(designs.addResource('jobs').addResource('{jobId}'), 'GET', generate);
    // GET /api/v1/designs/{designId}/guide → generate
    const design = designs.addResource('{designId}');
    addRoute(design.addResource('guide'), 'GET', generate);
    // GET /api/v1/designs/{designId}/nodes/{nodeId}/explanation → explain
    addRoute(design.addResource('nodes').addResource('{nodeId}').addResource('explanation'), 'GET', explain);
  }
}
