import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  OriginRequestPolicy,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { RestApiOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { Api } from './api';
import { ArchimateConfig, resourceName } from './config';

export interface WebProps {
  readonly config: ArchimateConfig;
  readonly api: Api;
}

/**
 * 정적 파일 변환: URI가 `/`로 끝나면 `index.html`을 붙인다. (예: `/designs/` → `/designs/index.html`)
 * Next.js 정적 내보내기 + `trailingSlash: true` 구조에 맞춘 방식이다. (인프라 #4)
 * 모든 경로를 `/index.html`로 보내는 SPA 방식은 쓰지 않는다.
 */
const INDEX_REWRITE_CODE = `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.charAt(uri.length - 1) === '/') {
    request.uri = uri + 'index.html';
  }
  return request;
}
`;

/**
 * 웹: S3 + CloudFront. (MVP_Task.md 3-5, 인프라 #3·#4, coding-conventions.md 12번)
 *
 * - S3는 비공개(퍼블릭 접근 차단, SSL 강제)이고 CloudFront만 OAC로 읽는다.
 * - 기본 동작은 S3, `/api/*` 동작은 3-4의 API Gateway다. 프론트는 상대 경로 `/api/v1`만 호출하므로 CORS가 필요 없다.
 * - CloudFront 오류 페이지(404→index.html 같은 errorResponses)는 설정하지 않는다.
 *   설정하면 API 에러 응답까지 HTML로 바뀐다. (인프라 #4)
 * - 프론트 파일은 BucketDeployment로 올리고 배포할 때마다 `/*` 캐시를 무효화한다.
 */
export class Web extends Construct {
  public readonly bucket: Bucket;
  public readonly distribution: Distribution;

  constructor(scope: Construct, id: string, props: WebProps) {
    super(scope, id);
    const { config, api } = props;
    const { stage } = config;

    this.bucket = new Bucket(this, 'Bucket', {
      // 버킷 이름은 전 세계에서 유일해야 한다. 이미 쓰인 이름이면 배포가 실패하므로 그때 이름 규칙을 협의한다.
      bucketName: resourceName(stage, 's3', 'web'),
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const rewriteFunction = new CloudFrontFunction(this, 'IndexRewrite', {
      functionName: resourceName(stage, 'cloudfront', 'rewrite'),
      // 런타임을 코드에 적어, cdk.json의 flag 여부와 관계없이 같은 결과가 나오게 한다.
      runtime: FunctionRuntime.JS_2_0,
      code: FunctionCode.fromInline(INDEX_REWRITE_CODE),
    });

    this.distribution = new Distribution(this, 'Distribution', {
      comment: resourceName(stage, 'cloudfront', 'web'),
      defaultBehavior: {
        // OAC(Origin Access Control)로 CloudFront만 버킷을 읽게 한다. 버킷 정책도 함께 만들어진다.
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [{ function: rewriteFunction, eventType: FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': {
          // REST API 호출 주소는 `/{스테이지 이름}/api/v1/...`이라서 오리진 경로에 스테이지 이름을 지정한다.
          // 그러면 CloudFront의 `/api/*`가 경로 변경 없이 API Gateway로 넘어간다.
          origin: new RestApiOrigin(api.restApi, { originPath: `/${stage}` }),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          // Authorization 헤더와 쿼리 문자열을 그대로 넘긴다. (Host 헤더만 제외)
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      // errorResponses를 설정하지 않는다.
    });

    // 프론트 결과물(없으면 플레이스홀더 페이지)을 올리고, 올린 뒤 `/*` 캐시를 무효화한다.
    new BucketDeployment(this, 'Deployment', {
      sources: [Source.asset(config.webSourcePath)],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      // 업로드를 처리하는 도우미 Lambda의 로그 그룹. 지정하지 않으면 보존 731일, 삭제 정책 Retain이라
      // `cdk destroy` 뒤에도 남는다. 다른 Lambda와 같이 2주 보존, DESTROY로 맞춘다. (명세 없음, 인프라 결정)
      logGroup: new LogGroup(this, 'DeploymentLogs', {
        retention: RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
  }
}

/** 출력값: CloudFront 주소. 출력 이름은 camelCase. */
export function addWebOutputs(scope: Construct, web: Web): void {
  new CfnOutput(scope, 'cloudFrontUrl', {
    value: `https://${web.distribution.distributionDomainName}`,
    description: 'CloudFront 주소 (프론트와 /api/* 공통)',
  });
}
