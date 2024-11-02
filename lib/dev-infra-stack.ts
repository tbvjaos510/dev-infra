import * as cdk from "aws-cdk-lib";
import { CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { IVpc, LaunchTemplate } from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as iam from "aws-cdk-lib/aws-iam";

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
    const volume = new ec2.Volume(this, "DatabaseVolume", {
      volumeName: "database-volume",
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
        "ec2:DescribeVolumes",
      ],
      resources: ["*"],
    }));

    const asg = new autoscaling.AutoScalingGroup(this, "auto-scaling-group", {
      vpc,
      minCapacity: 1,
      maxCapacity: 1,
      newInstancesProtectedFromScaleIn: false,
      vpcSubnets: {
        availabilityZones: [vpc.availabilityZones[0]],
      },
      mixedInstancesPolicy: {
        instancesDistribution: {
          spotMaxPrice: "0.007",
          onDemandPercentageAboveBaseCapacity: 0,
          spotAllocationStrategy: autoscaling.SpotAllocationStrategy.LOWEST_PRICE,
        },
        launchTemplate: new LaunchTemplate(this, "launch-template", {
          launchTemplateName: "dev-ecs-cluster-launch-template",
          keyPair: ec2.KeyPair.fromKeyPairName(this, "key-pair", "home-keypair"),
          machineImage: ecs.EcsOptimizedImage.amazonLinux2023(),
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
while ! lsblk | grep -E 'xvdf|nvme1n1' > /dev/null; do
    echo "Waiting for volume to be attached..."
    sleep 5
done

# 디바이스 이름 결정
if lsblk | grep nvme1n1 > /dev/null; then
    DEVICE_NAME="/dev/nvme1n1"
else
    DEVICE_NAME="/dev/xvdf"
fi

# 파일시스템 확인 및 생성
if ! blkid $DEVICE_NAME; then
    echo "Creating filesystem on $DEVICE_NAME..."
    mkfs -t ext4 $DEVICE_NAME
fi

# 마운트 포인트 생성 및 마운트
mkdir -p /data
mount $DEVICE_NAME /data
echo "$DEVICE_NAME /data ext4 defaults,nofail 0 2" >> /etc/fstab

# MongoDB 데이터 디렉터리 생성
mkdir -p /data/mongodb

`),
          role,
          httpTokens: ec2.LaunchTemplateHttpTokens.OPTIONAL,
        }),
        launchTemplateOverrides: [
          {
            instanceType: new ec2.InstanceType("t3.micro"),
          },
          {
            instanceType: new ec2.InstanceType("t3a.micro"),
          },
          {
            instanceType: new ec2.InstanceType("t2.micro"),
          },
        ],
      },
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
