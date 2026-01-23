# Configuring AWS SDK (v3)

The c3vis server uses the AWS JavaScript SDK v3 clients to connect to AWS APIs.

As per [Configuring the SDK for JavaScript v3](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/loading-node-credentials-shared.html), the SDK will get its configuration from the server's environment and default credential chain.

## Provide Explicit AWS SDK Configuration with `aws_config.json` Configuration File

AWS SDK configuration can be overridden by providing an `aws_config.json` file (this file location is overridable with `aws.configFile` option, see [CONFIGURATION.md](CONFIGURATION.md)). The file is used to set the region and, optionally, explicit credentials.

E.g. to set the region used by c3vis server to `us-east-1`, create an `aws_config.json` file in the root directory with the following:

```
{
  "region": "us-east-1"
}
```

The contents of this file override all other sources of AWS SDK configuration for c3vis.

## AWS Region

As per above section, AWS Region can be provided in local `aws_config.json` file.

Otherwise the Region will be configured as per [Setting the AWS Region](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-region.html).

## AWS Credentials

If using `aws_config.json` file as per above section, you can add AWS credentials properties `accessKeyId`, `secretAccessKey`, and optionally `sessionToken` to the `aws_config.json`.
See [https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/loading-node-credentials-shared.html](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/loading-node-credentials-shared.html).

*NOTE: Storing credentials in plaintext file is not recommended, especially if there is a risk this file could be committed to version control.*

Otherwise, the credentials will be loaded as per priority listed [here](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/credential-providers.html).

## IAM Role Permissions

### EC2 IAM Role Permissions

When running c3vis on EC2 instances using an IAM role, ensure the role has the 
following permissions:

* `ecs:listContainerInstances`
* `ecs:describeContainerInstances`
* `ecs:listTasks`
* `ecs:describeTasks`
* `ecs:describeTaskDefinition`
* `ecs:listClusters`
* `ec2:describeInstances`

Sample IAM Inline Policy:
```
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "ecs:listContainerInstances",
                "ecs:describeContainerInstances",
                "ecs:listTasks",
                "ecs:describeTasks",
                "ecs:describeTaskDefinition",
                "ecs:listClusters",
                "ec2:describeInstances"
            ],
            "Resource": [
                "*"
            ]
        }
    ]
}
```

### ECS IAM Task Role

When running c3vis on an ECS cluster, you can use an ECS Task IAM Role, which
 can be created using the process documented [here](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html#create_task_iam_policy_and_role).
Ensure the IAM Policy has the permissions listed above.

## Security Warning 

**WARNING:** c3vis makes ECS data from the above API calls (including environment variables in task definitions) available to clients/browsers.
Ensure the c3vis server is available only to users that should have access to this information.
