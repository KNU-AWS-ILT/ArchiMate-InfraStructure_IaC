#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { ArchimateStack } from '../lib/archimate-stack';
import { loadConfig, stackName } from '../lib/config';

const app = new App();
const config = loadConfig(app);

new ArchimateStack(app, stackName(config.stage), {
  config,
  // 계정은 지정하지 않는다. synth는 자격 증명 없이 동작하고, 배포 때는 현재 AWS 프로필의 계정을 쓴다.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region },
  description: `ArchiMate serverless stack (${config.stage})`,
});
