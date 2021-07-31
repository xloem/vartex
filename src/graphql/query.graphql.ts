import * as R from 'rambda';
import { types as CassandraTypes } from 'cassandra-driver';
import { config } from 'dotenv';
import { KEYSPACE } from '../constants.js';
import { indices } from '../utility/order.utility.js';
import { ISO8601DateTimeString } from '../utility/encoding.utility.js';
import { TagFilter } from './types.js';
import { tagToB64, toB64url } from '../query/transaction.query.js';
import * as DbMapper from '../database/mapper.database.js';
import { default as cqlBuilder } from '@ridi/cql-builder';

const { Insert, Select, Update, Delete, CqlBuilderError } = cqlBuilder;

export type TxSortOrder = 'HEIGHT_ASC' | 'HEIGHT_DESC';

config();

export interface QueryParams {
  to?: string[];
  from?: string[];
  id?: string;
  ids?: string[];
  limit?: number;
  offset?: number;
  select?: any;
  blocks?: boolean;
  since?: string;
  sortOrder?: TxSortOrder;
  status?: 'any' | 'confirmed' | 'pending';
  tags?: TagFilter[];
  pendingMinutes?: number;
  minHeight?: number;
  maxHeight?: CassandraTypes.Long;
}

export function generateTransactionQuery(params: QueryParams): any {
  // const { to, from, tags, id, ids, status = 'confirmed', select } = params;

  const cql = Select()
    .table('transaction', KEYSPACE)
    .field(params.select)
    .filtering();

  if (params.id) {
    cql.where('id = ?', params.id);
  } else if (params.ids && Array.isArray(params.ids)) {
    cql.where.apply(
      cql,
      R.concat(
        [
          `id IN ( ${R.range(0, params.ids.length)
            .map(() => '?')
            .join(', ')} )`,
        ],
        params.ids
      )
    );
  }

  if (params.since) {
    cql.where(
      'block_timestamp < ?',
      CassandraTypes.Long.fromNumber(
        Math.floor(
          CassandraTypes.TimeUuid.fromString(params.since).getDate().valueOf() /
            1000
        )
      )
    );
  }

  if (params.status === 'confirmed') {
    cql.where('block_height >= ?', CassandraTypes.Long.fromNumber(0));
  }

  if (params.to) {
    cql.where('target = ?', params.to);
  }

  cql.where('block_height >=', params.minHeight);

  cql.where('block_height <=', params.maxHeight);

  // if (params.sortOrder === 'HEIGHT_ASC') {
  //   cql.order('block_height ASC');
  // } else {
  //   cql.order('block_height DESC');
  // }

  return cql.build();
}

export interface BlockQueryParams {
  id?: string;
  ids?: string[];
  select?: any;
  before?: string;
  offset: number;
  fetchSize: number;
  minHeight?: number;
  maxHeight?: CassandraTypes.Long;
  sortOrder?: TxSortOrder;
}

export function generateBlockQuery(params: BlockQueryParams): any {
  const {
    id,
    ids,
    select,
    before,
    offset = 0,
    fetchSize,
    minHeight,
    maxHeight,
  } = params;

  const cql = Select()
    .table(
      params.sortOrder === 'HEIGHT_ASC' ? 'block_gql_asc' : 'block_gql_desc',
      KEYSPACE
    )
    .field(select)
    .filtering();

  // const query = connection.queryBuilder().select(select).from('blocks');
  if (id) {
    cql.where('indep_hash = ?', id);
  } else if (ids && Array.isArray(ids) && !R.isEmpty(ids)) {
    cql.where.apply(
      cql,
      R.concat(
        [
          `indep_hash IN ( ${R.range(0, params.ids.length)
            .map(() => '?')
            .join(', ')} )`,
        ],
        params.ids
      )
    );
  }

  if (before) {
    cql.where('timestamp < ?', before);
  }

  cql.where(
    'height >= ?',
    params.sortOrder === 'HEIGHT_ASC' ? minHeight + offset : minHeight
  );

  cql.where(
    'height <= ?',
    params.sortOrder === 'HEIGHT_DESC'
      ? (maxHeight as any).sub(offset).toString()
      : maxHeight.toString()
  );

  cql.limit(fetchSize);

  return cql.build();
}

export function generateTagQuery(tags: TagFilter[]) {
  const cql = Select().table('tx_tag', KEYSPACE).field('tx_id').filtering();
  tags.forEach((tag) => {
    cql.where('name = ?', tag.name.toString());
    if (Array.isArray(tag.values)) {
      cql.where.apply(
        cql,
        R.concat(
          [
            `value IN ( ${R.range(0, tag.values.length)
              .map(() => '?')
              .join(', ')} )`,
          ],
          tag.values
        )
      );
    } else {
      cql.where('value = ?', (tag.values as any).toString());
    }
  });
  return cql.build();
}
