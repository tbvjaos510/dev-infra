import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { IVpc, LaunchTemplate, Vpc } from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as iam from "aws-cdk-lib/aws-iam";
import { CfnOutput } from "aws-cdk-lib";

export class DevInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, "vpc", {
      vpcName: "default",
    });

    const cluster = new ecs.Cluster(this, "ecs-cluster", {
      clusterName: "my-dev-ecs-cluster",
      vpc,
    });

    this.serviceScalingGroup(vpc, cluster);
  }

  private serviceScalingGroup(vpc: IVpc, cluster: ecs.Cluster) {
    const eip = new ec2.CfnEIP(this, "upbit-ip");
    const role = new iam.Role(this, "AutoScalingEIPRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
    });

    // EBS 볼륨 생성
    const volume = new ec2.Volume(this, 'DatabaseVolume', {
      volumeName: 'database-volume',
      availabilityZone: vpc.availabilityZones[0], // 첫 번째 AZ 사용
      size: cdk.Size.gibibytes(10),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    role.addToPolicy(new iam.PolicyStatement({
      actions: [
        "ec2:AssociateAddress",
        "ec2:DisassociateAddress",
        // EBS 관련 권한 추가
        "ec2:AttachVolume",
        "ec2:DetachVolume",
        "ec2:DescribeVolumes"
      ],
      resources: ["*"],
    }));

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
VOLUME_ID=${volume.volumeId}
AVAILABILITY_ZONE=$(curl -s http://169.254.169.254/latest/meta-data/placement/availability-zone)

# EIP 연결
echo Running: aws ec2 associate-address --instance-id $INSTANCE_ID --allocation-id $ALLOC_ID --allow-reassociation
AWS_DEFAULT_REGION=ap-northeast-2 aws ec2 associate-address --instance-id $INSTANCE_ID --allocation-id $ALLOC_ID --allow-reassociation

# EBS 볼륨 연결
echo "Attaching EBS volume..."
aws ec2 attach-volume --volume-id $VOLUME_ID --instance-id $INSTANCE_ID --device /dev/xvdf --region ap-northeast-2

# 볼륨이 연결될 때까지 대기
while ! lsblk | grep xvdf > /dev/null; do
    echo "Waiting for volume to be attached..."
    sleep 5
done

# 파일시스템 확인 및 생성
if ! blkid /dev/xvdf; then
    echo "Creating filesystem on /dev/xvdf..."
    mkfs -t ext4 /dev/xvdf
fi

# 마운트 포인트 생성 및 마운트
mkdir -p /data
mount /dev/xvdf /data
echo "/dev/xvdf /data ext4 defaults,nofail 0 2" >> /etc/fstab

# Create directory for MongoDB data
mkdir -p /data/mongodb
`),
        role,
        httpTokens: ec2.LaunchTemplateHttpTokens.OPTIONAL,
      }),
    });

    const capacityProvider = new ecs.AsgCapacityProvider(this, "AsgCapacityProvider", {
      autoScalingGroup: asg,
      machineImageType: ecs.MachineImageType.AMAZON_LINUX_2,
      spotInstanceDraining: true,
    });

    cluster.addAsgCapacityProvider(capacityProvider);

    new CfnOutput(this, "Public IP", {
      value: eip.attrPublicIp,
    });
  }
}
