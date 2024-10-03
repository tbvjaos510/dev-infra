import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { LaunchTemplate } from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as iam from "aws-cdk-lib/aws-iam";

export class DevInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, "vpc", {
      vpcName: "default",
    });

    const eip = new ec2.CfnEIP(this, "upbit-ip");

    const role = new iam.Role(this, "AutoScalingEIPRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
    });

    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "ec2:AssociateAddress",
        "ec2:DisassociateAddress",
      ],
      resources: ["*"],
    }));

    const cluster = new ecs.Cluster(this, "ecs-cluster", {
      clusterName: "my-dev-ecs-cluster",
      vpc,
    });

    const asg = new autoscaling.AutoScalingGroup(this, "auto-scaling-group", {
      vpc,
      minCapacity: 1,
      maxCapacity: 1,
      newInstancesProtectedFromScaleIn: false,
      launchTemplate: new LaunchTemplate(this, "launch-template", {
        launchTemplateName: "dev-ecs-cluster-launch-template",
        keyPair: ec2.KeyPair.fromKeyPairName(this, "key-pair", "home-keypair"),
        machineImage: ecs.EcsOptimizedImage.amazonLinux2023(),
        instanceType: new ec2.InstanceType("t2.micro"),
        spotOptions: {
          requestType: ec2.SpotRequestType.ONE_TIME,
        },
        userData: ec2.UserData.custom(`#!/bin/bash
yum install awscli -y
echo ECS_CLUSTER=${cluster.clusterName} >> /etc/ecs/ecs.config;

INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
ALLOC_ID=${eip.attrAllocationId}

# Now we can associate the address
echo Running: aws ec2 associate-address --instance-id $INSTANCE_ID --allocation-id $ALLOC_ID --allow-reassociation
AWS_DEFAULT_REGION=ap-northeast-2 aws ec2 associate-address --instance-id $INSTANCE_ID --allocation-id $ALLOC_ID --allow-reassociation
`),
        role,
        httpTokens: ec2.LaunchTemplateHttpTokens.OPTIONAL,
      }),
    });


    // ECS Capacity Provider 생성
    const capacityProvider = new ecs.AsgCapacityProvider(this, "AsgCapacityProvider", {
      autoScalingGroup: asg,
      machineImageType: ecs.MachineImageType.AMAZON_LINUX_2,
      spotInstanceDraining: true,
    });

    // ECS 클러스터에 Capacity Provider 추가
    cluster.addAsgCapacityProvider(capacityProvider);
  }
}
