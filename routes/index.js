const config = require('../config/config');
const debug = require('debug')('api');
const express = require('express');
const router = express.Router();
const fs = require('fs');
const moment = require('moment');
const AWS = require('aws-sdk');
const batchPromises = require('batch-promises');
// AWS variable has default credentials from Shared Credentials File or Environment Variables.
//   (see: https://docs.aws.amazon.com/AWSJavaScriptSDK/guide/node-configuring.html)
// Override default credentials with configFile (e.g. './aws_config.json') if it exists
if (fs.existsSync(config.aws.configFile)) {
  console.log(`Updating with settings from '${config.aws.configFile}'...`);
  AWS.config.update(JSON.parse(fs.readFileSync(config.aws.configFile, 'utf8')));
}
console.log(`Targeting AWS region '${AWS.config.region}'`);

const utils = require('./utils');

const FetchStatus = require('./fetchStatus');
const ClusterState = require('./clusterState');
const clusterStateCache = require('../routes/clusterStateCache');
const clusterStateCacheTtl = config.clusterStateCacheTtl;
const taskDefinitionCache = require('memory-cache');
const promiseDelayer = require('./promiseDelayer');
const staticClusterDataProvider = require('./staticClusterDataProvider.js');

const ecs = new AWS.ECS();
const ec2 = new AWS.EC2();
// helper to tolerate old aws-sdk-promise `.data` wrapping
const safe = (obj, key) => (obj && (obj[key] || (obj.data && obj.data[key])));

// helper to assume role
async function ecsClientForRole(roleArn, region, externalId) {
  const sts = new AWS.STS();
  const params = { RoleArn: roleArn, RoleSessionName: `c3vis-${Date.now()}` };
  if (externalId) params.ExternalId = externalId;
  const { Credentials: c } = await sts.assumeRole(params).promise();
  return new AWS.ECS({
    region,
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken
  });
}

// helper to get short cluster name for console URLs
function clusterShortName(cluster) {
  return cluster && cluster.startsWith('arn:')
    ? cluster.substring(cluster.lastIndexOf('/') + 1)
    : cluster;
}

// base account id cache
let BASE_ACCOUNT_ID;
async function getBaseAccountId() {
  if (BASE_ACCOUNT_ID) return BASE_ACCOUNT_ID;
  const sts = new AWS.STS();
  const id = await sts.getCallerIdentity({}).promise();
  BASE_ACCOUNT_ID = id.Account;
  return BASE_ACCOUNT_ID;
}

// map of accountId -> roleArn, e.g. "111122223333=arn:aws:iam::111122223333:role/c3vis-readonly,..."
function loadRoleMap() {
  const map = {};
  const raw = process.env.C3VIS_ROLE_MAP || '';
  raw.split(',').map(s => s.trim()).filter(Boolean).forEach(pair => {
    const [acct, arn] = pair.split('=');
    if (acct && arn) map[acct] = arn;
  });
  return map;
}
const ROLE_MAP = loadRoleMap();

function accountIdFromCluster(cluster) {
  // arn:aws:ecs:<region>:<account>:cluster/<name>
  return cluster && cluster.startsWith('arn:') ? cluster.split(':')[4] : null;
}

async function clientsForCluster(cluster) {
  const region = AWS.config.region;
  const acct = accountIdFromCluster(cluster);
  const baseAcct = await getBaseAccountId();

  if (!acct || acct === baseAcct) {
    return { ecsClient: ecs, ec2Client: ec2 };
  }

  const roleArn = ROLE_MAP[acct];
  if (!roleArn) {
    throw new Error(`No role mapping for account ${acct}. Set C3VIS_ROLE_MAP env var.`);
  }
  const ecsClient = await ecsClientForRole(roleArn, region, process.env.C3VIS_EXTERNAL_ID);
  // build matching EC2 client with same temp creds
  const sts = new AWS.STS();
  const { Credentials: c } = await sts.assumeRole({
    RoleArn: roleArn, RoleSessionName: `c3vis-ec2-${Date.now()}`,
    ...(process.env.C3VIS_EXTERNAL_ID ? { ExternalId: process.env.C3VIS_EXTERNAL_ID } : {})
  }).promise();
  const ec2Client = new AWS.EC2({
    region, accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken
  });
  return { ecsClient, ec2Client };
}



/* Home page */

router.get('/', function (req, res, next) {
  res.render('index', {
    title: 'c3vis - Cloud Container Cluster Visualizer',
    useStaticData: staticDataRequested(req),
    resourceType: req.query.resourceType ? req.query.resourceType : 'memory'
  });
});

function staticDataRequested(req) {
  return req.query.static ? (req.query.static.toLowerCase() === "true") : false;
}

/* API endpoints
 * =============
 * Endpoints take a "?static=true" query param to enable testing with static data when AWS credentials aren't available
 */

router.get('/api/instance_summaries_with_tasks', function (req, res, next) {
  Promise.resolve()
  .then(function() {
    debugLog(`Headers: ${JSON.stringify(req.headers, null, 4)}`);
    if (!req.query.cluster) {
      send400Response("Please provide a 'cluster' parameter", res);
      reject("No 'cluster' parameter provided.");
    } else {
      const clusterName = req.query.cluster;
      const useStaticData = staticDataRequested(req);
      const forceRefresh = req.query.forceRefresh === 'true';
      return getInstanceSummariesWithTasks(res, clusterName, useStaticData, forceRefresh);
    }
  })
  .catch(function (err) {
    const reason = new Error(`Failed getting instance summaries: ${err}`);
    reason.stack += `\nCaused By:\n` + err.stack;
    sendErrorResponse(reason, res);
  });
});

function getInstanceSummariesWithTasks(res, clusterName, useStaticData, forceRefresh) {
  return Promise.resolve(getOrInitializeClusterState(clusterName, forceRefresh))
  .then(function(clusterState) {
    if (clusterState == null) {
      throw new Error(`clusterState for '${clusterName}' cluster not cached and could not be initialised.`);
    } else if (clusterState.fetchStatus === FetchStatus.ERROR) {
      // Server previously encountered an error while asynchronously processing cluster. Send error to client.
      console.log(`Sending current state to client with fetchStatus '${clusterState.fetchStatus}'.`);
      sendErrorResponse(clusterState.errorDetails, res);
      return clusterState;
    } else {
      // Send current state to client. If only just initialised, next then() block will process in background while client polls periodically
      console.log(`Sending current state to client with fetchStatus '${clusterState.fetchStatus}'.`);
      res.json(clusterState);
      return clusterState;
    }
  })
  .then(function(clusterState) {
    if (clusterState.fetchStatus === FetchStatus.INITIAL) {
      // Populate cluster state in the background while client polls asynchronously
      if (useStaticData) {
        populateStaticClusterStateWithInstanceSummaries(clusterName);
      } else {
        populateClusterStateWithInstanceSummaries(clusterName);
      }
    }
  })
  .catch(function(err) {
    console.log(`${err}\n${err.stack}`);
    setClusterStateError(clusterName, err);
    // NOTE: Don't re-throw here, to avoid 'UnhandledPromiseRejectionWarning' in router calling function
  });
}

function populateStaticClusterStateWithInstanceSummaries(clusterName) {
  console.log(`populateStaticClusterStateWithInstanceSummaries(${clusterName})`);
  updateClusterState(clusterName, FetchStatus.FETCHING, {});
  try {
    // Return some static instance details with task details
    const instanceSummaries = staticClusterDataProvider.getStaticClusterData(clusterName);
    updateClusterState(clusterName, FetchStatus.FETCHED, instanceSummaries);
  } catch (err) {
    console.log(`${err}\n${err.stack}`);
    setClusterStateError(clusterName, `Encountered error processing static file for '${clusterName}' cluster: ${err}`);
  }
}

function updateClusterState(clusterName, status, instanceSummaries) {
  console.log(`Setting fetch status to "${status}" for cluster "${clusterName}"`);
  const clusterState = getOrInitializeClusterState(clusterName);
  clusterState.fetchStatus = status;
  clusterState.instanceSummaries = instanceSummaries;
  console.log(`Updated: clusterState for '${clusterName}' cluster = ${JSON.stringify(clusterState)}`)
}

function getOrInitializeClusterState(clusterName, forceRefresh = false) {
  // NOTE: Cache will return null if cluster is not yet cached OR if cluster entry has expired
  let clusterState = clusterStateCache.get(clusterName);
  if (clusterState != null && forceRefresh) {
    console.log(`Client requested a force refresh of cluster data already cached at ${clusterState.createTimestamp} (${moment(clusterState.createTimestamp).fromNow()})`);
  }
  if (clusterState == null || forceRefresh) {
    clusterState = new ClusterState(clusterName);
    clusterStateCache.put(clusterName, clusterState, clusterStateCacheTtl);
  }
  return clusterState;
}

function setClusterStateError(clusterName, errorDetails) {
  console.log(`Setting errorDetails for '${clusterName}' cluster to: ${errorDetails}`);
  const clusterState = getOrInitializeClusterState(clusterName);
  clusterState.fetchStatus = FetchStatus.ERROR;
  clusterState.errorDetails = errorDetails;
}

function populateClusterStateWithInstanceSummaries(cluster) {
  console.log(`populateClusterStateWithInstanceSummaries(${cluster})`);
    updateClusterState(cluster, FetchStatus.FETCHING, {});

    clientsForCluster(cluster)
      .then(({ ecsClient, ec2Client }) => {
        let tasksArray = [];
        return getTasksWithTaskDefinitions(cluster, ecsClient)
          .then(function (tasksResult) {
            tasksArray = tasksResult;
            return listAllContainerInstances(cluster, ecsClient);
          })
          .then(function (listAllContainerInstanceArns) {
            debugLog(`\tFound ${listAllContainerInstanceArns.length} ContainerInstanceARNs...`);
            if (listAllContainerInstanceArns.length === 0) {
              return null;
            } else {
              const containerInstanceBatches = listAllContainerInstanceArns
                .map((instances, index) =>
                  index % config.aws.describeInstancesPageSize === 0
                    ? listAllContainerInstanceArns.slice(index, index + config.aws.describeInstancesPageSize)
                    : null)
                .filter(Boolean);

              return batchPromises(1, containerInstanceBatches, containerInstanceBatch => new Promise((resolve, reject) => {
                debugLog(`\tCalling ecs.describeContainerInstances for Container Instance batch: ${containerInstanceBatch}`);
                resolve(ecsClient.describeContainerInstances({
                  cluster: cluster,
                  containerInstances: containerInstanceBatch
                }).promise().then(promiseDelayer.delay(config.aws.apiDelay)));
              }));
            }
          })
          .then(function (describeContainerInstancesResponses) {
            if (!describeContainerInstancesResponses || describeContainerInstancesResponses.length === 0) {
              console.warn("No Container Instances found");
              updateClusterState(cluster, FetchStatus.FETCHED, []);
              return;
            }

            const containerInstances = describeContainerInstancesResponses.reduce(function (acc, current) {
              return acc.concat(safe(current, 'containerInstances') || []);
            }, []);
            const ec2instanceIds = containerInstances.map(i => i.ec2InstanceId);
            console.log(`Found ${ec2instanceIds.length} ec2InstanceIds for cluster '${cluster}': ${ec2instanceIds}`);

            return ec2Client.describeInstances({ InstanceIds: ec2instanceIds }).promise()
              .then(function (ec2Instances) {
                const instances = [].concat.apply([], (safe(ec2Instances, 'Reservations') || []).map(r => r.Instances));
                const privateIpAddresses = instances.map(i => i.PrivateIpAddress);
                console.log(`\twith ${privateIpAddresses.length} matching Private IP addresses: ${privateIpAddresses}`);

                const short = clusterShortName(cluster);
                const instanceSummaries = containerInstances.map(function (instance) {
                  const ec2IpAddress = (instances.find(i => i.InstanceId === instance.ec2InstanceId) || {}).PrivateIpAddress;
                  return {
                    "ec2IpAddress": ec2IpAddress,
                    "ec2InstanceId": instance.ec2InstanceId,
                    "ec2InstanceConsoleUrl": "https://console.aws.amazon.com/ec2/v2/home?region=" + AWS.config.region + "#Instances:instanceId=" + instance.ec2InstanceId,
                    "ecsInstanceConsoleUrl": "https://console.aws.amazon.com/ecs/home?region=" + AWS.config.region + "#/clusters/" + short + "/containerInstances/" + instance["containerInstanceArn"].substring(instance["containerInstanceArn"].lastIndexOf("/") + 1),
                    "registeredCpu": utils.registeredCpu(instance),
                    "registeredMemory": utils.registeredMemory(instance),
                    "remainingCpu": utils.remainingCpu(instance),
                    "remainingMemory": utils.remainingMemory(instance),
                    "tasks": tasksArray.filter(t => t.containerInstanceArn === instance.containerInstanceArn)
                  }
                });
                updateClusterState(cluster, FetchStatus.FETCHED, instanceSummaries);
              });
          });
      })
      .catch(function (err) {
        setClusterStateError(cluster, err);
      });
}

router.get('/api/cluster_names', function (req, res, next) {
  const useStaticData = staticDataRequested(req);
  getClusterNames(useStaticData, res);
});

function getClusterNames(useStaticData, res) {
  if (useStaticData) {
    return res.json(["demo-cluster-8", "demo-cluster-50", "demo-cluster-75", "demo-cluster-100", "invalid"]);
  }

  const assumeList = (process.env.C3VIS_ASSUME_ROLE_ARNS || "")
      .split(",").map(s => s.trim()).filter(Boolean);

    const region = AWS.config.region;
    const baseEcs = new AWS.ECS({ region });

    const listFrom = async (ecsClient) =>
      ecsClient.listClusters({}).promise().then(r => r.clusterArns || []);

    const promises = [
      listFrom(baseEcs), // current account
      ...assumeList.map(async (arn) => {
        const ecsX = await ecsClientForRole(arn, region, process.env.C3VIS_EXTERNAL_ID);
        return listFrom(ecsX);
      })
    ];

    Promise.all(promises)
      .then(results => {
        const arns = [...new Set([].concat(...results))];
        // return ARNs (UI will send them back to us)
        res.json(arns);
      })
      .catch(err => sendErrorResponse(err, res));
}

function listAllContainerInstances(cluster, ecsClient) {
  return new Promise(function (resolve, reject) {
    listContainerInstanceWithToken(cluster, null, [], ecsClient)
      .then(resolve)
      .catch(reject);
  });
}

function listContainerInstanceWithToken(cluster, token, instanceArns, ecsClient) {
  const params = { cluster: cluster, maxResults: config.aws.listInstancesPageSize };
  if (token) params['nextToken'] = token;

  debugLog("Calling ecs.listContainerInstances...");
  return ecsClient.listContainerInstances(params).promise()
    .then(function (listContainerInstanceResponse) {
      const containerInstanceArns = instanceArns.concat(safe(listContainerInstanceResponse, 'containerInstanceArns') || []);
      const nextToken = safe(listContainerInstanceResponse, 'nextToken');
      if (containerInstanceArns.length === 0) {
        return [];
      } else if (nextToken) {
        return listContainerInstanceWithToken(cluster, nextToken, containerInstanceArns, ecsClient);
      } else {
        return containerInstanceArns;
      }
    });
}

function listAllTasks(cluster, ecsClient) {
  return new Promise(function (resolve, reject) {
    listTasksWithToken(cluster, null, [], ecsClient)
      .then(resolve)
      .catch(reject);
  });
}

function listTasksWithToken(cluster, token, tasks, ecsClient) {
  const params = { cluster: cluster, maxResults: config.aws.listTasksPageSize };
  if (token) params['nextToken'] = token;

  debugLog(`\tCalling ecs.listTasks with token: ${token} ...`);
  return ecsClient.listTasks(params).promise()
    .then(promiseDelayer.delay(config.aws.apiDelay))
    .then(function (tasksResponse) {
      const taskArnsPage = safe(tasksResponse, 'taskArns') || [];
      debugLog(`\t\tReceived tasksResponse with ${taskArnsPage.length} Task ARNs`);
      const taskArns = tasks.concat(taskArnsPage);
      const nextToken = safe(tasksResponse, 'nextToken');
      if (taskArns.length === 0) {
        return [];
      } else if (nextToken) {
        return listTasksWithToken(cluster, nextToken, taskArns, ecsClient);
      } else {
        debugLog(`\t\tReturning ${taskArns.length} taskArns from listTasksWithToken: ${taskArns}`);
        return taskArns;
      }
    });
}

function getTasksWithTaskDefinitions(cluster, ecsClient) {
  console.log(`Getting Tasks annotated with Task Definitions for cluster '${cluster}'...`);
  return new Promise(function (resolve, reject) {
    let tasksArray = [];
    listAllTasks(cluster, ecsClient)
      .then(function (allTaskArns) {
        if (allTaskArns.length === 0) {
          console.warn("\tNo Task ARNs found");
          resolve([]);
        } else {
          return allTaskArns.map(function (tasks, index) {
            return index % config.aws.describeTasksPageSize === 0 ? allTaskArns.slice(index, index + config.aws.describeTasksPageSize) : null;
          }).filter(Boolean);
        }
      })
      .then(function (taskBatches) {
        return batchPromises(config.aws.maxSimultaneousDescribeTasksCalls, taskBatches, taskBatch => new Promise((resolve, reject) => {
          debugLog(`\tCalling ecs.describeTasks for Task batch: ${taskBatch}`);
          resolve(ecsClient.describeTasks({ cluster: cluster, tasks: taskBatch }).promise()
            .then(promiseDelayer.delay(config.aws.apiDelay)));
        }));
      })
      .then(function (describeTasksResponses) {
        tasksArray = describeTasksResponses.reduce(function (acc, current) {
          return acc.concat(safe(current, 'tasks') || []);
        }, []);
        console.log(`Found ${tasksArray.length} tasks for cluster '${cluster}'`);
        return batchPromises(config.aws.maxSimultaneousDescribeTaskDefinitionCalls, tasksArray, task => new Promise((resolve, reject) => {
          const cachedTaskDef = taskDefinitionCache.get(task.taskDefinitionArn);
          if (cachedTaskDef) {
            resolve(cachedTaskDef);
          } else {
            debugLog(`\tCalling ecs.describeTaskDefinition for Task Definition ARN: ${task.taskDefinitionArn}`);
            resolve(ecsClient.describeTaskDefinition({ taskDefinition: task.taskDefinitionArn }).promise()
              .then(promiseDelayer.delay(config.aws.apiDelay))
              .then(function (taskDefinition) {
                debugLog(`\t\tReceived taskDefinition for ARN "${task.taskDefinitionArn}". Caching in memory.`);
                taskDefinitionCache.put(task.taskDefinitionArn, taskDefinition);
                return taskDefinition;
              })
              .catch(function (err) {
                debugLog(`\t\tFAILED ecs.describeTaskDefinition call for '${task.taskDefinitionArn}': ${err}`);
                return Promise.reject(err);
              }));
          }
        }));
      })
      .then(function (taskDefs) {
        console.log(`Found ${taskDefs.length} task definitions for cluster '${cluster}'`);
        taskDefs.forEach(function (taskDef) {
          tasksArray
            .filter(function (t) {
              return t.taskDefinitionArn === (safe(taskDef, 'taskDefinition') || {}).taskDefinitionArn;
            })
            .forEach(function (t) {
              t.taskDefinition = safe(taskDef, 'taskDefinition');
            });
        });
        resolve(tasksArray);
      })
      .catch(function (err) {
        console.error("\nCaught error in getTasksWithTaskDefinitions():", err);
        reject(err);
      });
  });
}


function send400Response(errMsg, res) {
  console.log(errMsg);
  res.status(400).send(`Error: ${errMsg}`);
}

function sendErrorResponse(err, res) {
  console.log(err);
  res.status(500).send(err.message || err);
}

function debugLog(msg) {
  debug(msg);
}

module.exports = router;
