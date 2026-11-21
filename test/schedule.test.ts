import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ArchimateStack } from '../lib/archimate-stack';
import { loadConfig } from '../lib/config';

type Json = Record<string, any>;

function synth(context?: Record<string, string>): Template {
  const app = new App({ context });
  const stack = new ArchimateStack(app, 'archimate-demo', { config: loadConfig(app) });
  return Template.fromStack(stack);
}

const template = synth();

const functionId = (name: string): string => {
  const found = Object.keys(template.findResources('AWS::Lambda::Function', { Properties: { FunctionName: name } }));
  expect(found).toHaveLength(1);
  return found[0];
};

const [ruleId, rule] = Object.entries(template.findResources('AWS::Events::Rule'))[0] as [string, Json];

describe('EventBridge 스케줄', () => {
  it('규칙은 1개이고 이름은 resourceName 규칙이다', () => {
    template.resourceCountIs('AWS::Events::Rule', 1);
    expect(rule.Properties.Name).toBe('archimate-demo-events-sync-prices');
  });

  it('매일 UTC 18:00(한국 시간 03:00)에 실행한다 (명세 없음, 임시값)', () => {
    expect(rule.Properties.ScheduleExpression).toBe('cron(0 18 * * ? *)');
    expect(rule.Properties.State).toBe('ENABLED');
  });

  it('대상은 sync_prices Lambda 하나뿐이다', () => {
    expect(rule.Properties.Targets).toHaveLength(1);
    expect(rule.Properties.Targets[0].Arn).toEqual({
      'Fn::GetAtt': [functionId('archimate-demo-lambda-sync-prices'), 'Arn'],
    });
  });

  it('EventBridge가 sync_prices를 호출할 권한이 이 규칙에만 허용된다', () => {
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'events.amazonaws.com',
      FunctionName: { 'Fn::GetAtt': [functionId('archimate-demo-lambda-sync-prices'), 'Arn'] },
      SourceArn: { 'Fn::GetAtt': [ruleId, 'Arn'] },
    });
  });

  it('generate와 explain에는 EventBridge 호출 권한이 없다', () => {
    const permissions = Object.values(template.findResources('AWS::Lambda::Permission')) as Json[];
    const events = permissions.filter((p) => p.Properties.Principal === 'events.amazonaws.com');
    expect(events).toHaveLength(1);
    for (const name of ['archimate-demo-lambda-generate', 'archimate-demo-lambda-explain']) {
      expect(JSON.stringify(events[0].Properties.FunctionName)).not.toContain(functionId(name));
    }
  });

  it('태그 3종이 붙는다', () => {
    expect(rule.Properties.Tags).toEqual(
      expect.arrayContaining([
        { Key: 'Environment', Value: 'demo' },
        { Key: 'Owner', Value: 'infra' },
        { Key: 'Project', Value: 'ArchiMate' },
      ]),
    );
  });

  it('스테이지를 바꾸면 이름이 따라간다', () => {
    synth({ stage: 'test' }).hasResourceProperties('AWS::Events::Rule', {
      Name: 'archimate-test-events-sync-prices',
    });
  });
});
