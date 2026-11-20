import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ArchimateStack } from '../lib/archimate-stack';
import { loadConfig, resourceName } from '../lib/config';

describe('resourceName', () => {
  it('archimate-{env}-{서비스}-{용도} 형태로 조합한다', () => {
    expect(resourceName('demo', 'dynamodb', 'designs')).toBe('archimate-demo-dynamodb-designs');
  });

  it('허용되지 않는 문자는 거부한다', () => {
    expect(() => resourceName('demo', 'Lambda', 'generate')).toThrow();
  });
});

describe('loadConfig', () => {
  it('기본 스테이지는 demo, 리전은 서울이다', () => {
    const config = loadConfig(new App());
    expect(config.stage).toBe('demo');
    expect(config.region).toBe('ap-northeast-2');
    expect(config.monthlyBudgetUsd).toBe(30);
  });

  it('잘못된 스테이지 이름은 거부한다', () => {
    const app = new App({ context: { stage: 'Prod_1' } });
    expect(() => loadConfig(app)).toThrow();
  });
});

describe('ArchimateStack', () => {
  it('빈 스택으로 합성된다 (리소스 없음)', () => {
    const app = new App();
    const stack = new ArchimateStack(app, 'archimate-demo', { config: loadConfig(app) });
    expect(Template.fromStack(stack).toJSON().Resources).toBeUndefined();
  });
});
