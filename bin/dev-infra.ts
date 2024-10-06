#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { DevInfraStack } from "../lib/dev-infra-stack";
import { MongoDbStack } from "../lib/mongo-db-stack";

const app = new cdk.App();
new DevInfraStack(app, "DevInfraStack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

new MongoDbStack(app, "MongoDbStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,

  },
});

app.synth();
