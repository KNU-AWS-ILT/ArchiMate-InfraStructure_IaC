import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ArchimateStack } from '../lib/archimate-stack';
import { loadConfig } from '../lib/config';

function synth(context?: Record<string, string>): Template {
  const app = new App({ context });
  const stack = new ArchimateStack(app, 'archimate-demo', { config: loadConfig(app) });
  return Template.fromStack(stack);
}

const template = synth();

function tableByName(name: string): Record<string, any> {
  const tables = template.findResources('AWS::DynamoDB::Table', {
    Properties: { TableName: name },
  });
  const found = Object.values(tables);
  expect(found).toHaveLength(1);
  return found[0];
}

describe('DynamoDB 테이블', () => {
  it('테이블은 3개다', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 3);
  });

  it('designs: 파티션 키 jobId만(정렬 키 없음), PITR 켬, TTL expiresAt (백엔드 #15 확정)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'archimate-demo-dynamodb-designs',
      KeySchema: [{ AttributeName: 'jobId', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'jobId', AttributeType: 'S' }],
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  it('prices: service / regionUsageType (백엔드 #15 확정)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'archimate-demo-dynamodb-prices',
      KeySchema: [
        { AttributeName: 'service', KeyType: 'HASH' },
        { AttributeName: 'regionUsageType', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'service', AttributeType: 'S' },
        { AttributeName: 'regionUsageType', AttributeType: 'S' },
      ],
    });
  });

  it('explanations: designId / nodeId, TTL expiresAt (백엔드 #15 확정)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'archimate-demo-dynamodb-explanations',
      KeySchema: [
        { AttributeName: 'designId', KeyType: 'HASH' },
        { AttributeName: 'nodeId', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'designId', AttributeType: 'S' },
        { AttributeName: 'nodeId', AttributeType: 'S' },
      ],
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  it('prices에는 TTL이 없다', () => {
    expect(tableByName('archimate-demo-dynamodb-prices').Properties.TimeToLiveSpecification).toBeUndefined();
  });

  it('PITR은 designs에만 있다', () => {
    expect(tableByName('archimate-demo-dynamodb-prices').Properties.PointInTimeRecoverySpecification).toBeUndefined();
    expect(
      tableByName('archimate-demo-dynamodb-explanations').Properties.PointInTimeRecoverySpecification,
    ).toBeUndefined();
  });

  it('모두 온디맨드다', () => {
    const tables = Object.values(template.findResources('AWS::DynamoDB::Table'));
    expect(tables).toHaveLength(3);
    for (const table of tables) {
      expect(table.Properties.BillingMode).toBe('PAY_PER_REQUEST');
    }
  });

  it('모두 삭제 정책이 DESTROY(Delete)다', () => {
    const tables = Object.values(template.findResources('AWS::DynamoDB::Table'));
    for (const table of tables) {
      expect(table.DeletionPolicy).toBe('Delete');
      expect(table.UpdateReplacePolicy).toBe('Delete');
    }
  });

  it('태그 3종이 붙는다', () => {
    template.allResourcesProperties('AWS::DynamoDB::Table', {
      Tags: Match.arrayWith([
        { Key: 'Environment', Value: 'demo' },
        { Key: 'Owner', Value: 'infra' },
        { Key: 'Project', Value: 'ArchiMate' },
      ]),
    });
  });

  it('스테이지를 바꾸면 이름과 Environment 태그가 따라간다', () => {
    const other = synth({ stage: 'test' });
    other.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'archimate-test-dynamodb-designs',
      Tags: Match.arrayWith([{ Key: 'Environment', Value: 'test' }]),
    });
  });
});
