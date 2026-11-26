import { RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { ArchimateConfig, resourceName } from './config';

export interface DataTablesProps {
  readonly config: ArchimateConfig;
}

/**
 * 데이터: DynamoDB 테이블 3개. (근거: 백엔드 README 데이터베이스 구조 표(feat/#8-interview-validation 브랜치), 백엔드 #7)
 *
 * 공통: 온디맨드, 삭제 정책 DESTROY.
 * 발표 직후 `cdk destroy` 한 번으로 테이블이 남지 않게 한다. (RETAIN이면 남아서 비용 발생)
 */
export class DataTables extends Construct {
  /** 설계 결과. 파티션 키 jobId, PITR, TTL */
  public readonly designs: Table;
  /** AWS 단가. 매일 sync_prices Lambda가 덮어쓴다. TTL 없음 */
  public readonly prices: Table;
  /** 노드 설명 캐시. 파티션 키 designId + 정렬 키 nodeId, TTL */
  public readonly explanations: Table;

  constructor(scope: Construct, id: string, props: DataTablesProps) {
    super(scope, id);
    const { stage, ttlAttributeName } = props.config;

    // 키 구조와 TTL 속성 이름은 백엔드 #15 확정. 정렬 키 없음.
    // 만료 시각(expiresAt)은 테이블이 아니라 Lambda가 항목을 쓸 때 계산해 넣는다.
    this.designs = new Table(this, 'Designs', {
      tableName: resourceName(stage, 'dynamodb', 'designs'),
      partitionKey: { name: 'jobId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: ttlAttributeName,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // 정렬 키 `regionUsageType`의 값은 "region#usageType" 형태로 조합한다. 속성 이름은 백엔드 #15 확정.
    // TTL 없음: 단가는 매일 덮어쓴다.
    this.prices = new Table(this, 'Prices', {
      tableName: resourceName(stage, 'dynamodb', 'prices'),
      partitionKey: { name: 'service', type: AttributeType.STRING },
      sortKey: { name: 'regionUsageType', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // 키 구조와 TTL 속성 이름은 백엔드 #15 확정.
    this.explanations = new Table(this, 'Explanations', {
      tableName: resourceName(stage, 'dynamodb', 'explanations'),
      partitionKey: { name: 'designId', type: AttributeType.STRING },
      sortKey: { name: 'nodeId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: ttlAttributeName,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
