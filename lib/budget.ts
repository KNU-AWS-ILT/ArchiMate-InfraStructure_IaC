import { Annotations } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { Construct } from 'constructs';
import { ArchimateConfig, BUDGET_ALERTS, resourceName } from './config';

export interface BudgetProps {
  readonly config: ArchimateConfig;
}

/**
 * 비용: AWS Budgets. (MVP_Task.md 3-6, product.md 5번 월 $30, 인프라 #6 알림 50·80·100%)
 *
 * 운영 알림은 Budgets 이메일뿐이다. CloudWatch 알람·대시보드·SNS 토픽은 만들지 않는다. (백엔드 #7)
 * Budgets는 계정 전체 비용을 기준으로 한다. (이 스택의 리소스만 따로 집계하지 않는다)
 *
 * 알림 이메일(`-c alertEmail=...`)이 없으면 Budgets를 만들지 않고 synth 경고만 낸다.
 * 가짜 주소를 넣으면 알림이 아무에게도 가지 않는 채로 배포될 수 있어서, 비용 안전장치를 조용히 빠뜨리는 것보다 낫다.
 */
export class Budget extends Construct {
  /** 알림 이메일이 없으면 만들지 않는다 */
  public readonly budget?: CfnBudget;

  constructor(scope: Construct, id: string, props: BudgetProps) {
    super(scope, id);
    const { stage, monthlyBudgetUsd, alertEmail } = props.config;

    if (!alertEmail) {
      Annotations.of(this).addWarning(
        'alertEmail이 없어 Budgets를 만들지 않았습니다. 배포할 때는 -c alertEmail=<이메일>을 넘기세요.',
      );
      return;
    }

    this.budget = new CfnBudget(this, 'Monthly', {
      budget: {
        budgetName: resourceName(stage, 'budgets', 'monthly'),
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: monthlyBudgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: BUDGET_ALERTS.map((alert) => ({
        notification: {
          notificationType: alert.type,
          comparisonOperator: 'GREATER_THAN',
          threshold: alert.thresholdPercent,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: [{ subscriptionType: 'EMAIL', address: alertEmail }],
      })),
    });
  }
}
