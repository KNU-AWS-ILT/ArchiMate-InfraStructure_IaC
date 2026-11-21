import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import { ArchimateConfig, SYNC_PRICES_SCHEDULE, resourceName } from './config';
import { Functions } from './functions';

export interface ScheduleProps {
  readonly config: ArchimateConfig;
  readonly functions: Functions;
}

/**
 * 스케줄: 매일 새벽 단가 동기화. (MVP_Task.md 3-6, sync_prices.py 주석)
 * EventBridge 규칙이 sync_prices Lambda를 실행하고 → Price List API(us-east-1) → prices 테이블을 덮어쓴다.
 * 대상으로 연결하면 EventBridge가 이 Lambda를 호출할 권한(Lambda 리소스 정책)도 함께 만들어진다.
 */
export class PriceSyncSchedule extends Construct {
  public readonly rule: Rule;

  constructor(scope: Construct, id: string, props: ScheduleProps) {
    super(scope, id);
    const { config, functions } = props;

    this.rule = new Rule(this, 'Rule', {
      ruleName: resourceName(config.stage, 'events', 'sync-prices'),
      description: '매일 새벽 AWS 단가를 동기화한다 (한국 시간 03:00)',
      // 명세 없음, 임시값: 한국 시간 03:00 = UTC 18:00. (EventBridge cron은 UTC 기준)
      schedule: Schedule.cron(SYNC_PRICES_SCHEDULE),
      targets: [new LambdaTarget(functions.syncPrices)],
    });
  }
}
