import * as R from "rambda";
import Fluture, { fork, parallel } from "fluture/index.js";
import Gauge from "gauge";
import GaugeThemes from "gauge/themes";
import { config } from "dotenv";
import { types as CassandraTypes } from "cassandra-driver";
import { KEYSPACE, POLLTIME_DELAY_SECONDS } from "../constants";
import { log } from "../utility/log";
import mkdirp from "mkdirp";
import { WorkerPool } from "../gatsby-worker";
import { MessagesFromWorker } from "../workers/message-types";
import { getHashList, getNodeInfo } from "../query/node";
import { BlockType, fetchBlockByHash } from "../query/block";
import { UnsyncedBlock } from "../types/cassandra";
import { cassandraClient, getMaxHeightBlock, toLong } from "./cassandra";
import * as Dr from "./doctor";

let gauge_: any;

const PARALLEL_WORKERS = Number.isNaN(process.env["PARALLEL_WORKERS"])
  ? 1
  : Number.parseInt(process.env["PARALLEL_WORKERS"] || "1");

process.env.NODE_ENV !== "test" && config();
mkdirp.sync("cache");

function filterNpmFlags(object) {
  const keyz: string[] = Object.keys(object);
  const out = {};
  for (const key of keyz) {
    if (!key.startsWith("npm")) {
      out[key] = object[key];
    }
  }
  return out;
}

const workerReadyPromises = R.range(1, PARALLEL_WORKERS + 1).reduce(
  (accumulator, index) => {
    let resolve: () => void;
    const promise = new Promise((resolve_: unknown) => {
      resolve = resolve_ as () => void;
    });
    accumulator[index] = { promise, resolve };
    return accumulator;
  },
  {}
);

const workerPool = new WorkerPool<typeof import("../workers/import-block")>(
  process.cwd() + "/src/workers/import-block",
  {
    numWorkers: PARALLEL_WORKERS,
    logFilter: (data) =>
      !/ExperimentalWarning:/.test(data) && !/node --trace-warnings/.test(data),
    env: R.mergeAll([
      {
        PWD: process.cwd(),
        TS_NODE_FILES: true,
        NODE_PATH: process.cwd() + "/node_modules",
        NODE_OPTIONS: `--require ${
          process.cwd() + "/node_modules/ts-node/register"
        }`,
      },
      filterNpmFlags(process.env),
    ]),
  }
);

const messagePromiseReceivers = {};

export const txInFlight: Record<string, number> = {};
const numberOr0 = (n): number => (Number.isNaN(n) ? 0 : n);
export const getTxsInFlight = (): number =>
  Object.values(txInFlight).reduce((a, b) => numberOr0(a) + numberOr0(b));

workerPool.onMessage((message: MessagesFromWorker, workerId: number): void => {
  switch (message.type) {
    case "worker:ready": {
      workerReadyPromises[workerId].resolve();
      break;
    }
    case "log:info": {
      log.info(`${message.message}`);
      break;
    }
    case "block:new": {
      if (typeof messagePromiseReceivers[workerId] === "function") {
        messagePromiseReceivers[workerId](message.payload);
        delete messagePromiseReceivers[workerId];
        delete txInFlight[`${workerId}`];
      }
      break;
    }
    case "stats:tx:flight": {
      txInFlight[`${workerId}`] =
        typeof message.payload === "number"
          ? message.payload
          : Number.parseInt(message.payload);
      gauge_ &&
        gauge_.show(
          `blocks: ${currentHeight}/${topHeight}\t tx: ${getTxsInFlight()}`
        );
      break;
    }
    default: {
      console.error("unknown worker message arrived", message);
    }
  }
});

const trackerTheme = GaugeThemes.newTheme(
  GaugeThemes({
    hasUnicode: false,
    hasColor: true,
  })
);

export let topHash = "";
export let gatewayHeight: CassandraTypes.Long = toLong(0);
export let topHeight = 0;
export let currentHeight = 0;

// export let topTxIndex: CassandraTypes.Long = toLong(0);

const developmentSyncLength: number | undefined =
  !process.env["DEVELOPMENT_SYNC_LENGTH"] ||
  R.isEmpty(process.env["DEVELOPMENT_SYNC_LENGTH"])
    ? undefined
    : Number.parseInt(process.env["DEVELOPMENT_SYNC_LENGTH"] as string);

// eslint-disable-next-line use-isnan
if (developmentSyncLength === Number.NaN) {
  console.error("Development sync range variable produced, illegal value NaN");
  process.exit(1);
}

let isPollingStarted = false;
// let isImportCacheGcRunning = true; // true because we want to wait before starting periodic gc runs
let isPaused = false;

export function togglePause(): void {
  isPaused = !isPaused;
}

async function resolveFork(previousBlock: BlockType): Promise<void> {
  isPaused = true;
  const pprevBlock = await fetchBlockByHash(previousBlock.previous_block);

  const blockQueryResult = await cassandraClient.execute(
    `SELECT height FROM ${KEYSPACE}.block WHERE indep_hash=?`,
    [pprevBlock.indep_hash]
  );

  if (blockQueryResult.rowLength > 0) {
    cassandraClient.eachRow(
      `SELECT height, indep_hash
       FROM ${KEYSPACE}.block
       WHERE height > ${blockQueryResult.rows[0].height.toString()} ALLOW FILTERING`,
      [],
      {
        autoPage: true,
        prepare: false,
        executionProfile: "fast",
      },
      async function (n, row) {
        await cassandraClient.execute(
          `DELETE
           FROM ${KEYSPACE}.block
           WHERE indep_hash = '${row.indep_hash}'`
        );
      },

      function () {
        isPaused = false;
        log.info(
          "fork diverges at " +
            blockQueryResult.rows[0].height.toString() +
            " waiting for missing blocks to be imported..."
        );
      }
    );
  } else {
    workerPool.single.importBlock(pprevBlock.height);
    return await resolveFork(pprevBlock);
  }
}

async function startPolling(): Promise<void> {
  if (!isPollingStarted) {
    isPollingStarted = true;
    log.info(
      "polling for new blocks every " + POLLTIME_DELAY_SECONDS + " seconds"
    );
  }

  const nodeInfo = await getNodeInfo({});

  if (!nodeInfo) {
    await new Promise(function (resolve) {
      setTimeout(resolve, POLLTIME_DELAY_SECONDS * 1000);
    });
    return startPolling();
  }

  [topHash, gatewayHeight] = await getMaxHeightBlock();

  if (nodeInfo.current === topHash) {
    // wait before polling again

    await new Promise(function (resolve) {
      setTimeout(resolve, POLLTIME_DELAY_SECONDS * 1000);
    });
    return startPolling();
  } else {
    const currentRemoteBlock = await fetchBlockByHash(nodeInfo.current);
    const previousBlock = await fetchBlockByHash(
      currentRemoteBlock.previous_block
    );

    // fork recovery
    if (previousBlock.indep_hash !== topHash) {
      log.info(
        "blocks out of sync with the remote node " +
          previousBlock.indep_hash +
          "!= " +
          topHash
      );
      await resolveFork(currentRemoteBlock);
      log.info("blocks are back in sync!");
    } else {
      await workerPool.single.importBlock(nodeInfo.height);
      await new Promise(function (resolve) {
        setTimeout(resolve, POLLTIME_DELAY_SECONDS * 1000);
      });

      // const newBlock = await queryGetBlock({
      //   height: nodeInfo.height,
      //   hash: nodeInfo.current,
      // });
      // if (newBlock !== undefined) {
      //   const newBlockHeight =
      //     newBlock.height !== null && !Number.isNaN(newBlock.height)
      //       ? toLong(newBlock.height)
      //       : toLong(0);
      //   log.info("new block arrived at height " + newBlockHeight.toString());
      //   const blockQueryCallback = makeBlockImportQuery(newBlock);
      // enqueueBlockQueue({
      //   nextHeight: toLong(-1),
      //   callback: blockQueryCallback.bind(blockQueue),
      //   height: newBlockHeight,
      //   type: "block",
      //   txCount: newBlock.txs ? newBlock.txs.length : 0,
      // });
      // } else {
      //   console.error("Querying for new tx failed");
      // }
    }
  }
  return startPolling();
}

async function detectFirstRun(): Promise<boolean> {
  const queryResponse = await cassandraClient.execute(
    `SELECT height
     FROM ${KEYSPACE}.block LIMIT 1`
  );
  return queryResponse && queryResponse.rowLength > 0 ? false : true;
}

function findMissingBlocks(hashList: string[]): Promise<UnsyncedBlock[]> {
  const hashListObject = hashList.reduce((accumulator, hash, height) => {
    accumulator[height] = { height, hash };
    return accumulator;
  }, {});

  log.info("[database] Looking for missing blocks...");
  return new Promise(function (
    resolve: (value?: UnsyncedBlock[]) => void,
    reject: (error: string) => void
  ) {
    cassandraClient.eachRow(
      `SELECT height, indep_hash, timestamp, txs
         FROM ${KEYSPACE}.block`,
      [],
      {
        autoPage: true,
        prepare: false,
        executionProfile: "fast",
      },
      async function (n, row) {
        const matchingRow = hashListObject[row.height];

        if (
          matchingRow &&
          R.equals(matchingRow["hash"], row.indep_hash) &&
          R.equals(matchingRow["height"], row.height)
        ) {
          // log.info('DEQUEUEING' + row.height);
          delete hashListObject[row.height];
        } else {
          log.info(`Found missing block: ${n}`);
        }
      },
      async function (error) {
        if (error) {
          reject((error || "").toString());
        } else {
          resolve(
            R.sortBy(R.prop("height"))(
              R.values(hashListObject) as UnsyncedBlock[]
            )
          );
        }
      }
    );
  });
}

export async function startSync({
  isTesting = false, // eslint-disable-line @typescript-eslint/no-unused-vars
}: {
  isTesting?: boolean;
}): Promise<void> {
  // wait until worker threads are ready
  await Promise.all(R.map(R.prop("promise"))(R.values(workerReadyPromises)));

  const hashList: string[] = await getHashList({});
  topHeight = hashList.length;
  const firstRun = await detectFirstRun();
  let lastBlock: CassandraTypes.Long = toLong(-1);
  // let lastTx: CassandraTypes.Long = toLong(-1);

  if (!firstRun) {
    // await Dr.enqueueUnhandledCache(
    //   enqueueIncomingTxQueue,
    //   enqueueTxQueue,
    //   txImportCallback,
    //   incomingTxCallback,
    //   txQueue
    // );

    const isMaybeMissingBlocks = await Dr.checkForBlockGaps();

    if (isMaybeMissingBlocks) {
      const blockGap = await Dr.findBlockGaps();
      if (!R.isEmpty(blockGap)) {
        console.error("Repairing missing block(s):", blockGap);

        let doneSignalResolve;
        const doneSignal = new Promise(function (resolve) {
          doneSignalResolve = resolve;
        });

        fork((error) => console.error(error))(() => {
          doneSignalResolve();
          console.log("Block repair done!");
        })(
          parallel(PARALLEL_WORKERS)(
            blockGap.map((height) =>
              Fluture(function (reject, fresolve) {
                workerPool.single
                  .importBlock(height)
                  .then(fresolve)
                  .catch(reject);
                lastBlock = height;
                return () => {
                  console.error(`Fluture.Parallel crashed`);
                  process.exit(1);
                };
              })
            )
          )
        );
        await doneSignal;
      }
    }

    // await Dr.findTxGaps();
    try {
      const result_ = await getMaxHeightBlock();
      lastBlock = result_[1];
    } catch {
      // console.error(error);
    }
  }

  const gauge = new Gauge(process.stderr, {
    // tty: 79,
    template: [
      { type: "progressbar", length: 0 },
      { type: "activityIndicator", kerning: 1, length: 2 },
      { type: "section", kerning: 1, default: "" },
      { type: "subsection", kerning: 1, default: "" },
    ],
  });
  gauge.setTheme(trackerTheme);

  let unsyncedBlocks: UnsyncedBlock[] = firstRun
    ? hashList.map((hash, height) => ({ hash, height }))
    : await findMissingBlocks(hashList);

  const initialLastBlock = toLong(
    unsyncedBlocks[0] ? unsyncedBlocks[0].height : 0
  );

  if (developmentSyncLength) {
    unsyncedBlocks = R.slice(
      developmentSyncLength,
      unsyncedBlocks.length,
      unsyncedBlocks
    );

    // initialLastBlock = toLong(developmentSyncLength).sub(1);
    gatewayHeight = initialLastBlock;
  } else {
    gatewayHeight = lastBlock;
  }

  // blockQueueState.nextHeight = initialLastBlock.lt(1)
  //   ? toLong(1)
  //   : initialLastBlock;
  // txQueueState.nextTxIndex = initialLastBlock.mul(MAX_TX_PER_BLOCK);
  // isImportCacheGcRunning = false;

  if (firstRun) {
    log.info(
      "[sync] database seems to be empty, starting preperations for import..."
    );
  } else if (R.isEmpty(unsyncedBlocks)) {
    log.info("[sync] fully synced db");
    startPolling();
    return;
  } else {
    log.info(
      `[sync] missing ${unsyncedBlocks.length} blocks, starting sync...`
    );
  }
  // check health
  // if (!firstRun) {
  //   await Dr.fixNonLinearBlockOrder();
  // }

  gauge.enable();
  gauge_ = gauge;
  fork(function (reason: string | void) {
    console.error("Fatal", reason || "");
    process.exit(1);
  })(function () {
    log.info("Database fully in sync with block_list");
    !isPollingStarted && startPolling();
  })(
    parallel(PARALLEL_WORKERS)(
      unsyncedBlocks.map(({ height }: { height: number }) => {
        return Fluture(function (reject, fresolve) {
          const singleJob = workerPool.single; // you have 1 job!
          const blockPromise = singleJob.importBlock(height);
          currentHeight = height;
          blockPromise
            .then(() => {
              fresolve({});
              gauge.show(
                `blocks: ${currentHeight}/${topHeight}\t tx: ${getTxsInFlight()}`
              );
            })
            .catch(reject);

          return () => {
            console.error(
              "Fatal error while importing block at height",
              height
            );
          };
        });
      })
    )
  );
}