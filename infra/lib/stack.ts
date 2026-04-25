import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface TgAiRelayBotStackProps extends cdk.StackProps {
  allowedUserIds: string;
  dailyUsdCap: string;
}

const SSM_PREFIX = '/tg-ai-relay-bot';

export class TgAiRelayBotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TgAiRelayBotStackProps) {
    super(scope, id, props);

    // ── DynamoDB ───────────────────────────────────────────────────────────
    const table = new ddb.Table(this, 'Table', {
      tableName: 'tg-ai-relay-bot',
      partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
      sortKey: { name: 'sk', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const projectRoot = path.join(__dirname, '..', '..');
    const lockfile = path.join(projectRoot, 'package-lock.json');
    const commonBundling = {
      minify: true,
      sourceMap: true,
      target: 'node22',
      externalModules: ['@aws-sdk/*'],
    };
    const commonEnvironment = {
      TABLE_NAME: table.tableName,
      ALLOWED_USER_IDS: props.allowedUserIds,
      DAILY_USD_CAP_PER_USER: props.dailyUsdCap,
      SSM_PREFIX,
      NODE_OPTIONS: '--enable-source-maps',
    };

    const ssmReadPolicy = new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_PREFIX}`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_PREFIX}/*`,
      ],
    });
    const kmsDecryptPolicy = new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
    });

    // ── Worker Lambda ──────────────────────────────────────────────────────
    // Triggered asynchronously by the Webhook Lambda. Runs the bot, streams
    // AI responses to Telegram. Long timeout — Telegram has already been ACK'd.
    const workerFn = new NodejsFunction(this, 'WorkerFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(projectRoot, 'src', 'worker.ts'),
      depsLockFilePath: lockfile,
      projectRoot,
      handler: 'handler',
      memorySize: 1024,
      timeout: cdk.Duration.minutes(5),
      environment: commonEnvironment,
      bundling: commonBundling,
    });
    table.grantReadWriteData(workerFn);
    workerFn.addToRolePolicy(ssmReadPolicy);
    workerFn.addToRolePolicy(kmsDecryptPolicy);

    // ── Webhook Lambda ─────────────────────────────────────────────────────
    // Receives Telegram updates, validates the secret, async-invokes the
    // Worker, returns 200 in <1s. Tight timeout so we can't accidentally hold
    // Telegram hostage.
    const webhookFn = new NodejsFunction(this, 'WebhookFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(projectRoot, 'src', 'webhook.ts'),
      depsLockFilePath: lockfile,
      projectRoot,
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        ...commonEnvironment,
        WORKER_FUNCTION_NAME: workerFn.functionName,
      },
      bundling: commonBundling,
    });
    webhookFn.addToRolePolicy(ssmReadPolicy);
    webhookFn.addToRolePolicy(kmsDecryptPolicy);
    workerFn.grantInvoke(webhookFn);

    // ── HTTP API ───────────────────────────────────────────────────────────
    const api = new apigw.HttpApi(this, 'Api', {
      apiName: 'tg-ai-relay-bot',
    });
    api.addRoutes({
      path: '/webhook',
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration('WebhookIntegration', webhookFn),
    });

    // ── Outputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: `${api.apiEndpoint}/webhook`,
      description: 'Register this with Telegram via setWebhook',
    });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'WorkerFunctionName', { value: workerFn.functionName });
  }
}
