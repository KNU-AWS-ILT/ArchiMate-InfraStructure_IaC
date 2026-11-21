import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { ArchimateStack } from '../lib/archimate-stack';
import { loadConfig } from '../lib/config';

type Json = Record<string, any>;

const EMAIL = 'team@example.com';

function build(context?: Record<string, string>): { template: Template; annotations: Annotations } {
  const app = new App({ context });
  const stack = new ArchimateStack(app, 'archimate-demo', { config: loadConfig(app) });
  return { template: Template.fromStack(stack), annotations: Annotations.fromStack(stack) };
}

const { template } = build({ alertEmail: EMAIL });
const budgets = Object.values(template.findResources('AWS::Budgets::Budget')) as Json[];

describe('AWS Budgets (알림 이메일이 있을 때)', () => {
  it('예산은 1개이고 이름은 resourceName 규칙이다', () => {
    template.resourceCountIs('AWS::Budgets::Budget', 1);
    expect(budgets[0].Properties.Budget.BudgetName).toBe('archimate-demo-budgets-monthly');
  });

  it('월 30 USD, 비용 기준이다', () => {
    const budget = budgets[0].Properties.Budget;
    expect(budget.BudgetType).toBe('COST');
    expect(budget.TimeUnit).toBe('MONTHLY');
    expect(budget.BudgetLimit).toEqual({ Amount: 30, Unit: 'USD' });
  });

  it('알림은 3개: 실제 50%, 실제 80%, 예측 100%', () => {
    const notifications = (budgets[0].Properties.NotificationsWithSubscribers as Json[]).map((n) => n.Notification);
    expect(notifications).toHaveLength(3);
    expect(
      notifications.map((n) => `${n.NotificationType} ${n.Threshold}${n.ThresholdType === 'PERCENTAGE' ? '%' : ''}`),
    ).toEqual(['ACTUAL 50%', 'ACTUAL 80%', 'FORECASTED 100%']);
    for (const n of notifications) {
      expect(n.ComparisonOperator).toBe('GREATER_THAN');
    }
  });

  it('모든 알림은 config의 이메일로 간다', () => {
    for (const entry of budgets[0].Properties.NotificationsWithSubscribers as Json[]) {
      expect(entry.Subscribers).toEqual([{ SubscriptionType: 'EMAIL', Address: EMAIL }]);
    }
  });

  it('태그 3종이 붙는다', () => {
    expect(budgets[0].Properties.ResourceTags).toEqual(
      expect.arrayContaining([
        { Key: 'Environment', Value: 'demo' },
        { Key: 'Owner', Value: 'infra' },
        { Key: 'Project', Value: 'ArchiMate' },
      ]),
    );
  });

  it('스테이지를 바꾸면 이름이 따라간다', () => {
    build({ alertEmail: EMAIL, stage: 'test' }).template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetName: 'archimate-test-budgets-monthly' }),
    });
  });
});

describe('알림 이메일이 없을 때', () => {
  const missing = build();

  it('synth는 실패하지 않고 Budgets를 만들지 않는다', () => {
    missing.template.resourceCountIs('AWS::Budgets::Budget', 0);
  });

  it('경고를 낸다', () => {
    missing.annotations.hasWarning('*', Match.stringLikeRegexp('alertEmail'));
  });

  it('이메일 형식이 잘못되면 거부한다', () => {
    expect(() => build({ alertEmail: 'not-an-email' })).toThrow();
  });
});

describe('운영 알림은 Budgets뿐이다 (백엔드 #7)', () => {
  it.each([
    ['이메일 있음', template],
    ['이메일 없음', build().template],
  ])('CloudWatch 알람·대시보드와 SNS 토픽이 없다 (%s)', (_label, target) => {
    target.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    target.resourceCountIs('AWS::CloudWatch::CompositeAlarm', 0);
    target.resourceCountIs('AWS::CloudWatch::Dashboard', 0);
    target.resourceCountIs('AWS::SNS::Topic', 0);
  });
});
