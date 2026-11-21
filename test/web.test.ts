import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CachePolicy, OriginRequestPolicy, ResponseHeadersPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { ArchimateStack } from '../lib/archimate-stack';
import { loadConfig } from '../lib/config';

type Json = Record<string, any>;

function synth(context?: Record<string, string>): Template {
  // 플레이스홀더를 올리도록, 존재하지 않는 폴더를 지정한다. (프론트 결과물 유무와 상관없이 같은 결과)
  const app = new App({ context: { webAssetPath: 'does-not-exist', ...context } });
  const stack = new ArchimateStack(app, 'archimate-demo', { config: loadConfig(app) });
  return Template.fromStack(stack);
}

const template = synth();

const only = (type: string): [string, Json] => {
  const found = Object.entries(template.findResources(type));
  expect(found).toHaveLength(1);
  return [found[0][0], found[0][1] as Json];
};

const [bucketId, bucket] = only('AWS::S3::Bucket');
const [distributionId, distribution] = only('AWS::CloudFront::Distribution');
const config: Json = distribution.Properties.DistributionConfig;

describe('S3 버킷', () => {
  it('버킷은 1개이고 이름은 resourceName 규칙이다', () => {
    expect(bucket.Properties.BucketName).toBe('archimate-demo-s3-web');
  });

  it('퍼블릭 접근을 모두 차단한다', () => {
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
  });

  it('SSL이 아닌 요청을 거부한다', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 's3:*',
            Principal: { AWS: '*' },
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('삭제 정책은 DESTROY이고 삭제할 때 파일까지 지운다', () => {
    expect(bucket.DeletionPolicy).toBe('Delete');
    expect(bucket.UpdateReplacePolicy).toBe('Delete');
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
    expect(bucket.Properties.Tags).toEqual(
      expect.arrayContaining([{ Key: 'aws-cdk:auto-delete-objects', Value: 'true' }]),
    );
  });

  it('태그 3종이 붙는다', () => {
    expect(bucket.Properties.Tags).toEqual(
      expect.arrayContaining([
        { Key: 'Environment', Value: 'demo' },
        { Key: 'Owner', Value: 'infra' },
        { Key: 'Project', Value: 'ArchiMate' },
      ]),
    );
  });
});

describe('OAC', () => {
  it('OAC(Origin Access Control)를 쓰고 OAI는 쓰지 않는다', () => {
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 0);
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      }),
    });
  });

  it('S3 오리진에 OAC가 연결된다', () => {
    const [oacId] = only('AWS::CloudFront::OriginAccessControl');
    const s3Origin = (config.Origins as Json[]).find((o) => o.S3OriginConfig);
    expect(s3Origin).toBeDefined();
    expect(s3Origin!.OriginAccessControlId).toEqual({ 'Fn::GetAtt': [oacId, 'Id'] });
  });

  it('버킷 읽기는 이 배포(CloudFront)에만 허용한다', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 's3:GetObject',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Condition: {
              StringEquals: {
                'AWS:SourceArn': Match.objectLike({
                  'Fn::Join': ['', Match.arrayWith([{ Ref: distributionId }])],
                }),
              },
            },
          }),
        ]),
      },
    });
  });
});

describe('CloudFront 기본 동작(S3)', () => {
  const behavior: Json = config.DefaultCacheBehavior;

  it('HTTPS로 리다이렉트한다', () => {
    expect(behavior.ViewerProtocolPolicy).toBe('redirect-to-https');
  });

  it('캐시 최적화 정책과 보안 헤더 정책을 쓴다', () => {
    expect(behavior.CachePolicyId).toBe(CachePolicy.CACHING_OPTIMIZED.cachePolicyId);
    expect(behavior.ResponseHeadersPolicyId).toBe(ResponseHeadersPolicy.SECURITY_HEADERS.responseHeadersPolicyId);
  });

  it('오리진은 S3 버킷이다', () => {
    const origin = (config.Origins as Json[]).find((o) => o.Id === behavior.TargetOriginId);
    expect(origin!.DomainName).toEqual({ 'Fn::GetAtt': [bucketId, 'RegionalDomainName'] });
  });

  it('CloudFront Function이 viewer-request에 붙어 있다', () => {
    const [functionId] = only('AWS::CloudFront::Function');
    expect(behavior.FunctionAssociations).toEqual([
      { EventType: 'viewer-request', FunctionARN: { 'Fn::GetAtt': [functionId, 'FunctionARN'] } },
    ]);
  });
});

describe('CloudFront Function', () => {
  const [, fn] = only('AWS::CloudFront::Function');
  const handler = new Function(`${fn.Properties.FunctionCode}; return handler;`)() as (e: Json) => Json;
  const rewrite = (uri: string): string => handler({ request: { uri } }).uri;

  it('이름은 resourceName 규칙이고 런타임은 JS 2.0이다', () => {
    expect(fn.Properties.Name).toBe('archimate-demo-cloudfront-rewrite');
    expect(fn.Properties.FunctionConfig.Runtime).toBe('cloudfront-js-2.0');
  });

  it('`/`로 끝나는 주소에 index.html을 붙인다', () => {
    expect(rewrite('/designs/')).toBe('/designs/index.html');
    expect(rewrite('/')).toBe('/index.html');
    expect(rewrite('/a/b/')).toBe('/a/b/index.html');
  });

  it('그 밖의 주소는 바꾸지 않는다 (모든 경로를 /index.html로 보내지 않는다)', () => {
    expect(rewrite('/designs')).toBe('/designs');
    expect(rewrite('/_next/static/app.js')).toBe('/_next/static/app.js');
    expect(rewrite('/designs/index.html')).toBe('/designs/index.html');
  });
});

describe('CloudFront /api/* 동작', () => {
  const apiBehavior = (config.CacheBehaviors as Json[]).find((b) => b.PathPattern === '/api/*')!;

  it('/api/* 동작이 하나 있다', () => {
    expect(config.CacheBehaviors).toHaveLength(1);
    expect(apiBehavior).toBeDefined();
  });

  it('캐시를 끈다', () => {
    expect(apiBehavior.CachePolicyId).toBe(CachePolicy.CACHING_DISABLED.cachePolicyId);
  });

  it('모든 메서드를 허용한다', () => {
    expect([...apiBehavior.AllowedMethods].sort()).toEqual(
      ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'].sort(),
    );
  });

  it('원본 요청 정책은 AllViewerExceptHostHeader다 (Authorization 헤더·쿼리 문자열 전달)', () => {
    expect(apiBehavior.OriginRequestPolicyId).toBe(OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER.originRequestPolicyId);
  });

  it('CloudFront Function은 붙지 않는다', () => {
    expect(apiBehavior.FunctionAssociations).toBeUndefined();
  });

  it('오리진은 3-4의 API Gateway이고 originPath는 /demo다', () => {
    const origin = (config.Origins as Json[]).find((o) => o.Id === apiBehavior.TargetOriginId)!;
    const [restApiId] = only('AWS::ApiGateway::RestApi');
    expect(origin.OriginPath).toBe('/demo');
    expect(JSON.stringify(origin.DomainName)).toContain(`"${restApiId}"`);
    expect(JSON.stringify(origin.DomainName)).toContain('execute-api');
    expect(origin.CustomOriginConfig.OriginProtocolPolicy).toBe('https-only');
  });

  it('스테이지를 바꾸면 originPath가 따라간다', () => {
    const other = synth({ stage: 'test' }).toJSON();
    const otherDistribution = Object.values(other.Resources as Json).find(
      (r: Json) => r.Type === 'AWS::CloudFront::Distribution',
    ) as Json;
    const origins = otherDistribution.Properties.DistributionConfig.Origins as Json[];
    expect(origins.map((o) => o.OriginPath).filter(Boolean)).toEqual(['/test']);
  });
});

describe('오류 페이지', () => {
  it('CloudFront 오류 페이지(CustomErrorResponses)를 설정하지 않는다', () => {
    expect(config.CustomErrorResponses).toBeUndefined();
  });
});

describe('프론트 업로드와 캐시 무효화', () => {
  const [, deployment] = only('Custom::CDKBucketDeployment');

  it('캐시 무효화 경로는 /* 이고 배포를 가리킨다', () => {
    expect(deployment.Properties.DistributionPaths).toEqual(['/*']);
    expect(deployment.Properties.DistributionId).toEqual({ Ref: distributionId });
    expect(deployment.Properties.DestinationBucketName).toEqual({ Ref: bucketId });
  });

  it('업로드가 끝난 뒤 무효화가 끝나기를 기다린다', () => {
    expect(deployment.Properties.WaitForDistributionInvalidation).toBe(true);
  });

  it('업로드 도우미 Lambda의 로그 그룹도 DESTROY다 (destroy 뒤 남지 않음)', () => {
    const groups = Object.values(template.findResources('AWS::Logs::LogGroup')) as Json[];
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.DeletionPolicy).toBe('Delete');
      expect(group.Properties.RetentionInDays).toBe(14);
    }
  });
});

describe('출력값', () => {
  it('CloudFront 주소를 camelCase 이름(cloudFrontUrl)으로 내보낸다', () => {
    const output = template.toJSON().Outputs.cloudFrontUrl;
    expect(output).toBeDefined();
    expect(output.Value).toEqual({
      'Fn::Join': ['', ['https://', { 'Fn::GetAtt': [distributionId, 'DomainName'] }]],
    });
  });
});

describe('이름과 태그', () => {
  it('배포 이름(Comment)은 resourceName 규칙이다', () => {
    expect(config.Comment).toBe('archimate-demo-cloudfront-web');
  });

  it('CloudFront 배포에 태그 3종이 붙는다', () => {
    expect(distribution.Properties.Tags).toEqual(
      expect.arrayContaining([
        { Key: 'Environment', Value: 'demo' },
        { Key: 'Owner', Value: 'infra' },
        { Key: 'Project', Value: 'ArchiMate' },
      ]),
    );
  });
});
