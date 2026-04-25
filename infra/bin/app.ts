#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { TgAiRelayBotStack } from '../lib/stack';

const app = new cdk.App();

const allowedUserIds = app.node.tryGetContext('allowedUserIds') ?? process.env.ALLOWED_USER_IDS ?? '';
const dailyUsdCap = app.node.tryGetContext('dailyUsdCap') ?? process.env.DAILY_USD_CAP_PER_USER ?? '2.00';

new TgAiRelayBotStack(app, 'TgAiRelayBotStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'eu-west-1',
  },
  allowedUserIds,
  dailyUsdCap: String(dailyUsdCap),
});
