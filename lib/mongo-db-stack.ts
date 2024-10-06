import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";

export class MongoDbStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, "vpc", {
      vpcName: "default",
    });

    const defaultSecurityGroup = ec2.SecurityGroup.fromLookupByName(
      this,
      "defaultSecurityGroup",
      "default",
      vpc
    );

    defaultSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(27017),
      "MongoDB Ingress"
    );

    const cluster = ecs.Cluster.fromClusterAttributes(this, "ecs-cluster", {
      clusterName: "my-dev-ecs-cluster",
      vpc,
      securityGroups: [defaultSecurityGroup],
    });

    // ECS Task Role with EBS permissions
    const taskRole = new iam.Role(this, "MongoDbTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ec2:AttachVolume",
          "ec2:DetachVolume",
          "ec2:DescribeVolumes",
        ],
        resources: ["*"],
      })
    );

    const taskDefinition = new ecs.Ec2TaskDefinition(this, "MongoDbTaskDef", {
      taskRole,
      executionRole: new iam.Role(this, "MongoDbExecutionRole", {
        assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            "service-role/AmazonECSTaskExecutionRolePolicy"
          ),
        ],
      }),
    });

    // Docker volume for MongoDB data
    taskDefinition.addVolume({
      name: "mongodb-data",
      dockerVolumeConfiguration: {
        driver: "local",
        scope: ecs.Scope.TASK,
        driverOpts: {
          'type': 'none',
          'device': '/data/mongodb',
          'o': 'bind'
        },
      },
    });

    const logGroup = new logs.LogGroup(this, "MongoDbLogGroup", {
      retention: logs.RetentionDays.ONE_WEEK,
    });

    const mongoDbPassword = new secretsmanager.Secret(this, "MongoDbPassword", {
      secretName: "MongoDbPassword",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "admin" }),
        generateStringKey: "password",
        excludeCharacters: "/@\"",
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const mongoContainer = taskDefinition.addContainer("MongoDbContainer", {
      image: ecs.ContainerImage.fromRegistry("mongo:latest"),
      logging: ecs.LogDriver.awsLogs({ streamPrefix: "MongoDb", logGroup }),
      environment: {
        "MONGODB_ENABLE_JOURNAL": "true",
        "MONGODB_SMALL_FILES": "true",
      },
      secrets: {
        MONGO_INITDB_ROOT_USERNAME: ecs.Secret.fromSecretsManager(mongoDbPassword, "username"),
        MONGO_INITDB_ROOT_PASSWORD: ecs.Secret.fromSecretsManager(mongoDbPassword, "password"),
      },
      cpu: 256,
      memoryReservationMiB: 256,
      ulimits: [
        {
          name: ecs.UlimitName.NOFILE,
          softLimit: 64000,
          hardLimit: 64000,
        },
      ],
      portMappings: [
        {
          containerPort: 27017,
          hostPort: 27017,
          protocol: ecs.Protocol.TCP,
        },
      ],
    });

    // Add container dependency for volume initialization
    mongoContainer.addMountPoints({
      sourceVolume: "mongodb-data",
      containerPath: "/data/db",
      readOnly: false,
    });

    const service = new ecs.Ec2Service(this, "MongoDbService", {
      cluster,
      taskDefinition,
      desiredCount: 1,
      enableExecuteCommand: true,
      deploymentController: {
        type: ecs.DeploymentControllerType.ECS,
      },
      circuitBreaker: {
        rollback: true
      },
      minHealthyPercent: 0,
      maxHealthyPercent: 100
    });
  }
}
