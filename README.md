# 개인프로젝트 인프라 구성

CDK를 사용하여 AWS 인프라를 구성합니다.

## 구성요소

최저비용으로 인프라를 구성하기 위해 노력했습니다.

- ECS
- EC2 (Spot)
- EIP (업비트 IP 고정용으로 쓰입니다)

## 사용중인 프로젝트

- [coin-dc-bot](https://github.com/tbvjaos510/coin-dc-bot/blob/main/infra/cdk.ts)
- [cgv-ticket (private)](https://github.com/tbvjaos510/cdv-ticket)
