import crypto from 'crypto';
import * as cassandra from 'cassandra-driver';
import * as R from 'rambda';
import { types as CassandraTypes } from 'cassandra-driver';
import { ImportQueue, Poa, TxOffset } from '../types/cassandra.types.js';
import { KEYSPACE } from '../constants.js';
import { config } from 'dotenv';

config();

const currentSessionId = CassandraTypes.TimeUuid.now();
const currentSessionRandomId = crypto.randomBytes(16);

const isNumeric = (s: any) => !(isNaN as any)(s);

export const toLong = (anyValue: any): CassandraTypes.Long =>
  (cassandra as any).types.Long.isLong(anyValue)
    ? anyValue
    : !anyValue && typeof anyValue !== 'string'
    ? (cassandra as any).types.Long.fromNumber(0)
    : typeof anyValue === 'string'
    ? (cassandra as any).types.Long.fromString(
        R.isEmpty(anyValue) ? '0' : anyValue
      )
    : (cassandra as any).types.Long.fromNumber(anyValue);

const contactPoints = process.env.CASSANDRA_CONTACT_POINTS
  ? JSON.parse(process.env.CASSANDRA_CONTACT_POINTS)
  : ['localhost:9042'];

export const cassandraClient = new cassandra.Client({
  contactPoints,
  localDataCenter: 'datacenter1',
  queryOptions: { isIdempotent: true },
  // encoding: {
  //   map: Map,
  //   set: Set,
  // },
  socketOptions: {
    connectTimeout: 5000,
    defunctReadTimeoutThreshold: 64,
    keepAlive: true,
    keepAliveDelay: 0,
    readTimeout: 30000,
    tcpNoDelay: true,
    coalescingThreshold: 65536,
  },
  protocolOptions: {
    maxSchemaAgreementWaitSeconds: process.env['DB_TIMEOUT']
      ? parseInt(process.env['DB_TIMEOUT'])
      : 30,
  },
  profiles: [
    new cassandra.ExecutionProfile('fast', {
      readTimeout: 5000,
      consistency: cassandra.types.consistencies.any,
      serialConsistency: cassandra.types.consistencies.any,
    }),
    new cassandra.ExecutionProfile('gql', {
      readTimeout: 5000,
      consistency: cassandra.types.consistencies.all,
      serialConsistency: cassandra.types.consistencies.serial,
    }),
    new cassandra.ExecutionProfile('full', {
      readTimeout: 15000,
      consistency: cassandra.types.consistencies.all,
      serialConsistency: cassandra.types.consistencies.serial,
      graphOptions: {
        writeConsistency: cassandra.types.consistencies.all,
      },
    }),
  ],
});

const poaKeys = [
  'option',
  'tx_path',
  'data_path',
  'chunk',
  'block_hash',
  'block_height',
];

const blockGqlKeys = ['height', 'indep_hash'];

const txTagKeys = ['tx_id', 'tag_index', 'next_tag_index', 'name', 'value'];

const txOffsetKeys = ['tx_id', 'size', 'offset'];

const transactionKeys = [
  'block_height',
  'block_hash',
  'block_timestamp',
  'data_root',
  'data_size',
  'data_tree',
  'format',
  'id',
  'last_tx',
  'owner',
  'quantity',
  'reward',
  'signature',
  'target',
  'tag_count',
];

const blockKeys = [
  'block_size',
  'cumulative_diff',
  'diff',
  'hash',
  'hash_list_merkle',
  'height',
  'indep_hash',
  'last_retarget',
  'nonce',
  'previous_block',
  'reward_addr',
  'reward_pool',
  'tags',
  'timestamp',
  'tx_root',
  'tx_tree',
  'txs',
  'wallet_list',
  'weave_size',
];

const transformPoaKeys = (obj: any): Poa => {
  const poa = obj['poa'] ? obj['poa'] : {};
  const poaObj = {} as Poa;
  poaObj['option'] = poa['option'] || '';
  poaObj['tx_path'] = poa['tx_path'] || '';
  poaObj['data_path'] = poa['data_path'] || '';
  poaObj['chunk'] = poa['chunk'] || '';
  poaObj['block_hash'] = obj['indep_hash'] || '';
  poaObj['block_height'] = toLong(obj['height']);
  return poaObj;
};

// note for optimization reasons
// we may store the data differently than we serve it (eg. bigint->string)
const transformBlockKey = (key: string, obj: any) => {
  switch (key) {
    case 'txs':
    case 'tx_tree': {
      const txs = obj[key] && Array.isArray(obj[key]) ? obj[key] : [];
      return txs;
    }
    case 'tags': {
      const tagSet = new Set();
      const tags = obj[key] && Array.isArray(obj[key]) ? obj[key] : [];
      if (tags.length === 0) {
        return [];
      } else {
        tags.forEach((tag = {} as any) => {
          tagSet.add(
            new (cassandra as any).types.Tuple(
              tag['name'] || '',
              tag['value'] || ''
            )
          );
        });
        return tagSet;
      }
    }

    case 'block_size':
    case 'diff':
    case 'height':
    case 'last_retarget':
    case 'reward_pool':
    case 'timestamp':
    case 'weave_size': {
      return toLong(obj[key]);
    }
    case 'cumulative_diff':
    case 'hash':
    case 'hash_list_merkle':
    case 'indep_hash':
    case 'nonce':
    case 'previous_block':
    case 'reward_addr':
    case 'tx_root':
    case 'wallet_list':
    case 'last_retarget': {
      if (obj[key] || isNumeric(obj[key])) {
        return typeof obj[key] === 'string' ? obj[key] : obj[key].toString();
      } else {
        return '';
      }
    }

    default: {
      console.error('Unknown key', key);
    }
  }
};

const transformTxKey = (key: string, txData: any, blockData: any) => {
  switch (key) {
    case 'block_timestamp': {
      return toLong(blockData['timestamp']);
    }
    case 'block_height': {
      return toLong(blockData['height']);
    }

    case 'block_hash': {
      return blockData['indep_hash'];
    }

    case 'data_tree': {
      const txs = txData[key] && Array.isArray(txData[key]) ? txData[key] : [];
      return txs;
    }
    case 'tag_count': {
      return !txData.tags || R.isEmpty(txData.tags) ? 0 : R.length(txData.tags);
    }
    case 'tags': {
      const tagSet = new Set();
      const tags = txData[key] && Array.isArray(txData[key]) ? txData[key] : [];
      if (tags.length === 0) {
        return [];
      } else {
        tags.forEach((tag = {} as any) => {
          tagSet.add(
            new (cassandra as any).types.Tuple(
              tag['name'] || '',
              tag['value'] || ''
            )
          );
        });
        return tagSet;
      }
    }

    case 'data_root':
    case 'id':
    case 'last_tx':
    case 'owner':
    case 'signature':
    case 'target': {
      if (txData[key]) {
        return typeof txData[key] === 'string'
          ? txData[key]
          : txData[key].toString();
      } else {
        return '';
      }
    }

    case 'data_size':
    case 'quantity':
    case 'reward': {
      return toLong(txData[key]);
    }

    case 'format': {
      return txData[key];
    }

    default: {
      console.error('Unknown key', key);
    }
  }
};

const transformTxOffsetKeys = (txObj: any): TxOffset => {
  const txOffset = txObj['tx_offset'] ? txObj['tx_offset'] : {};
  const txOffsetObj = {} as TxOffset;
  txOffsetObj['tx_id'] = txObj['id'] || '';
  txOffsetObj['size'] = toLong(txOffset['size'] || 0);
  txOffsetObj['offset'] = toLong(txOffset['offset'] || -1);
  return txOffsetObj;
};

interface Tag {
  tag_index: number;
  tx_id: string;
  name: string;
  value: string;
}

type UpstreamTag = { name: string; value: string };

const transformTag = (
  tag: UpstreamTag,
  txObj: any,
  index: number,
  nextIndex?: number
): Tag => {
  const tagObj = {} as Tag;
  tagObj['tag_index'] = index;
  tagObj['next_tag_index'] = nextIndex || undefined;
  tagObj['tx_id'] = txObj['id'];
  tagObj['name'] = tag.name || '';
  tagObj['value'] = tag.value || '';
  return tagObj;
};

const poaInsertQuery = `INSERT INTO ${KEYSPACE}.poa (${poaKeys.join(
  ', '
)}) VALUES (${poaKeys.map(() => '?').join(', ')})`;

const blockInsertQuery = (nonNilBlockKeys: string[]) =>
  `INSERT INTO ${KEYSPACE}.block (${nonNilBlockKeys.join(
    ', '
  )}) VALUES (${nonNilBlockKeys.map(() => '?').join(', ')})`;

const transactionInsertQuery = (nonNilTxKeys: string[]) =>
  `INSERT INTO ${KEYSPACE}.transaction (${nonNilTxKeys.join(
    ', '
  )}) VALUES (${nonNilTxKeys.map(() => '?').join(', ')})`;

const txOffsetInsertQuery = `INSERT INTO ${KEYSPACE}.tx_offset (${txOffsetKeys.join(
  ', '
)}) VALUES (${txOffsetKeys.map(() => '?').join(', ')})`;

const txTagsInsertQuery = `INSERT INTO ${KEYSPACE}.tx_tag (${txTagKeys.join(
  ', '
)}) VALUES (${txTagKeys.map(() => '?').join(', ')})`;

// const blockStatusUpdateQuery = `
//   UPDATE gateway.block_status
//   SET synced = true
//   WHERE block_height = ? and block_hash = ?`;

const blockHeightByHashInsertQuery = `INSERT INTO ${KEYSPACE}.block_height_by_block_hash (block_height, block_hash) VALUES (?, ?) IF NOT EXISTS`;

const blockByTxIdInsertQuery = `INSERT INTO ${KEYSPACE}.block_by_tx_id (tx_id, block_height, block_hash) VALUES (?, ?, ?) IF NOT EXISTS`;

const blockGqlInsertAscQuery = `INSERT INTO ${KEYSPACE}.block_gql_asc (partition_id, height, indep_hash, timestamp) VALUES ('gql1', ?, ?, ?)`;

const blockGqlInsertDescQuery = `INSERT INTO ${KEYSPACE}.block_gql_desc (partition_id, height, indep_hash, timestamp) VALUES ('gql2', ?, ?, ?)`;

// Note the last synced block isn't
// nececcarily the latest one, than
// always needs verification on init
// const syncStatusUpdateQuery = `
//   UPDATE gateway.sync_status
//   SET last_block_height = ?, last_block_hash = ?
//   WHERE session_uuid = ? and random_uuid = ?`;

// const syncStatusLastBlocklistHeightUpdateQuery = `
//   UPDATE gateway.sync_status
//   SET last_hash_list_length = ?
//   WHERE session_uuid = ? and random_uuid = ?`;

// const pollStatusInsertQuery = `
//   INSERT INTO gateway.poll_status
//   (current_block_hash,current_block_height,random_uuid,time_uuid)
//   VALUES (?, ?, ?, ?)
// `;

export const makeTxImportQuery = (
  tx: { [k: string]: any },
  blockData: { [k: string]: any }
) => () => {
  let dataSize: CassandraTypes.Long | undefined;
  const nonNilTxKeys: string[] = [];
  const txInsertParams: { [k: string]: any } = transactionKeys.reduce(
    (paramz: Array<any>, key: string) => {
      const nextVal = transformTxKey(key, tx, blockData);

      if (key === 'data_size') {
        dataSize = nextVal;
      }
      if (nextVal && !R.isEmpty(nextVal)) {
        paramz.push(nextVal);
        nonNilTxKeys.push(key);
      }

      return paramz;
    },
    []
  );

  return [
    cassandraClient.execute(
      blockByTxIdInsertQuery,
      [tx.id, blockData.height, blockData.indep_hash],
      {
        prepare: true,
        executionProfile: 'full',
      }
    ),
    cassandraClient.execute(
      transactionInsertQuery(nonNilTxKeys),
      txInsertParams,
      { prepare: true, executionProfile: 'full' }
    ),
  ]
    .concat(
      (tx.tags || []).map((tag: UpstreamTag, index: number) =>
        cassandraClient.execute(
          txTagsInsertQuery,
          transformTag(
            tag,
            tx,
            index,
            index + 1 < tx.tags.length ? index + 1 : undefined
          ),
          {
            prepare: true,
            executionProfile: 'full',
          }
        )
      )
    )
    .concat(
      dataSize && dataSize.gt(0)
        ? [
            cassandraClient.execute(
              txOffsetInsertQuery,
              transformTxOffsetKeys(tx),
              {
                prepare: true,
                executionProfile: 'full',
              }
            ),
          ]
        : []
    );
};

// export const newSyncStatus = ({
//   blockHeight,
//   blockHash,
// }: {
//   blockHeight: CassandraTypes.Long;
//   blockHash: string;
// }): Promise<unknown> => {
//   return cassandraClient.execute(syncStatusUpdateQuery, [
//     blockHeight,
//     blockHash,
//     currentSessionId,
//     currentSessionRandomId,
//   ]);
// };

// export const newLastSessionHashSyncStatus = ({
//   lastSessionHashLength,
// }: {
//   lastSessionHashLength: CassandraTypes.Long;
// }): Promise<unknown> => {
//   return cassandraClient.execute(syncStatusLastBlocklistHeightUpdateQuery, [
//     lastSessionHashLength,
//     currentSessionId,
//     currentSessionRandomId,
//   ]);
// };

export const makeBlockImportQuery = (input: any) => () => {
  const nonNilBlockKeys: string[] = [];
  const blockInsertParams = blockKeys.reduce(
    (paramz: Array<any>, key: string) => {
      const nextVal = transformBlockKey(key, input);
      if (nextVal && !R.isEmpty(nextVal)) {
        paramz.push(nextVal);
        nonNilBlockKeys.push(key);
      }

      return paramz;
    },
    []
  );
  const blockTimeUuid = CassandraTypes.TimeUuid.fromDate(
    new Date(input.timestamp * 1000)
  );
  return [
    cassandraClient.execute(poaInsertQuery, transformPoaKeys(input), {
      prepare: true,
      executionProfile: 'full',
    }),
    cassandraClient.execute(
      blockGqlInsertAscQuery,
      [input.height, input.indep_hash, blockTimeUuid],
      { prepare: true, executionProfile: 'full' }
    ),
    cassandraClient.execute(
      blockGqlInsertDescQuery,
      [input.height, input.indep_hash, blockTimeUuid],
      { prepare: true, executionProfile: 'full' }
    ),
    cassandraClient.execute(
      blockHeightByHashInsertQuery,
      [input.height, input.indep_hash],
      { prepare: true, executionProfile: 'full' }
    ),
    cassandraClient.execute(
      blockInsertQuery(nonNilBlockKeys),
      blockInsertParams,
      { prepare: true, executionProfile: 'full' }
    ),
  ];
};

export const getMaxHeightBlock = async (): Promise<
  [string, CassandraTypes.Long]
> => {
  // note that the block_hash table is sorted descendingly by block height
  const response = await cassandraClient.execute(
    `SELECT height,indep_hash FROM ${KEYSPACE}.block_gql limit 1;`
  );

  const row = response.rows[0];
  if (row) {
    return [row['indep_hash'], row['height']];
  } else {
    return ['', toLong(-1)];
  }
};

// export const makeBlockPlaceholder = (
//   blockHeight: CassandraTypes.Long | number,
//   blockHash: string
// ): Promise<unknown> =>
//   cassandraClient.execute(
//     `INSERT INTO gateway.block_status (block_height, block_hash, synced, txs_synced)` +
//       ` VALUES (?, ?, ?, ?) IF NOT EXISTS`,
//     [toLong(blockHeight), blockHash, false, false]
//   );

// export const getBlockStatus = async (): Promise<CassandraTypes.Long> => {
//   let cnt = (cassandra as any).types.Long.fromNumber(0);
//   try {
//     const response = await cassandraClient.execute(
//       `SELECT * FROM gateway.block_status limit 1;`
//     );
//     cnt = response.rows[0].block_height;
//   } catch (error) {}

//   return cnt;
// };
