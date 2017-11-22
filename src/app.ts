import * as express from 'express';
import * as expressLogger from 'morgan';
import * as helmet from 'helmet';
import * as cors from 'cors';
import * as expressWsFactory from 'express-ws';
import * as ProviderEngine from 'web3-provider-engine';
import * as FilterSubprovider from 'web3-provider-engine/subproviders/filters';
import * as RpcSubprovider from 'web3-provider-engine/subproviders/rpc';
import { createClient } from 'redis';
import { Request, Response, NextFunction } from 'express';
import { BigNumber } from 'bignumber.js';
import { Pool } from 'pg';
import { PassThrough } from 'stream';
import { ZeroEx, ExchangeEvents } from '0x.js';
import { Relay, PostgresRelay } from './modules/relay';
import { OrderWatcher } from './modules/order-watcher';
import v0ApiRouteFactory from './modules/rest-api/routes';
import { WebSocketNode } from './modules/ws-api/websocket-node';
import { RoutingError } from './types';
import { ConsoleLoggerFactory, Logger } from './util/logger';
import { populateDatabase } from './sample-data/generate-data';
import config from './config';
BigNumber.config({
  EXPONENTIAL_AT: 1000,
});

const createApp = async () => {
  const isProduction = config.NODE_ENV === 'production' ? true : false;
  const logger: Logger = ConsoleLoggerFactory({ level: config.LOG_LEVEL });
  const BLOCKCHAIN_NETWORK_ENDPOINT = config.BLOCKCHAIN_NETWORK_ENDPOINT;
  const BLOCKCHAIN_STARTING_BLOCK = config.BLOCKCHAIN_STARTING_BLOCK;
  const ZEROEX_EXCHANGE_SOL_ADDRESS = config.ZERO_EX_EXCHANGE_SOL_ADDRESS;

  logger.log('info', 'Conduit starting...');
  const providerEngine = new ProviderEngine();
  providerEngine.addProvider(new FilterSubprovider());
  providerEngine.addProvider(new RpcSubprovider({ rpcUrl: BLOCKCHAIN_NETWORK_ENDPOINT }));
  providerEngine.start();

  const zeroEx = new ZeroEx(providerEngine, {
    orderWatcherConfig: { eventPollingIntervalMs: 1000 },
  });
  const { orderStateWatcher } = zeroEx;

  // Set up Redis
  const redisPublisher = config.REDIS_URL ? createClient(config.REDIS_URL) : createClient();
  const redisSubscriber = config.REDIS_URL ? createClient(config.REDIS_URL) : createClient();
  logger.log('debug', 'Connected to Redis instance');

  // Set up Relay Client (Postgres flavor)
  let relayClient: Relay;
  try {
    const pool = config.DATABASE_URL
      ? new Pool({ connectionString: config.DATABASE_URL })
      : new Pool({
          user: config.PGUSER,
          password: config.PGPASSWORD,
          host: config.PGHOST,
          database: config.PGDATABASE,
          port: config.PGPORT,
        });
    relayClient = new PostgresRelay({
      postgresPool: pool,
      orderTableName: config.PG_ORDERS_TABLE_NAME || 'orders',
      tokenTableName: config.PG_TOKENS_TABLE_NAME || 'tokens',
      tokenPairTableName: config.PG_TOKEN_PAIRS_TABLE_NAME || 'token_pairs',
      zeroEx,
      logger,
      redisPublisher,
      redisSubscriber,
    });
    await pool.connect();
    logger.log('debug', `Connected to Postgres database`);
    if (config.PG_POPULATE_DATABASE) {
      populateDatabase(relayClient, zeroEx, logger);
    }
  } catch (e) {
    logger.log('error', 'Error connecting to Postgres', e);
    throw e;
  }

  // Set up order watcher
  const orderWatcher = new OrderWatcher(zeroEx, relayClient, redisPublisher, redisSubscriber);
  logger.log('debug', `Connected to order watcher`);
  const orders = await relayClient.getOrders();
  await orderWatcher.watchOrderBatch(orders);
  logger.log('debug', `Subscribed to updates for all ${orders.length} active orders`);

  // Set up express application (REST/WS endpoints)
  const app = express();
  const expressWs = expressWsFactory(app);
  app.set('trust proxy', true);
  app.use('/', express.static(__dirname + '/public'));
  app.use(expressLogger('dev'));
  app.use(helmet());
  app.use(cors());

  app.get('/healthcheck', (req, res) => res.sendStatus(200));
  app.get('/', (req, res) => res.send('Welcome to the Conduit Relay API'));
  app.use('/api/v0', v0ApiRouteFactory(relayClient, zeroEx, logger));
  logger.log('verbose', 'Configured REST endpoints');

  const wss = expressWs.getWss('/ws');
  const webSocketNode = new WebSocketNode({
    logger,
    wss,
    redisPublisher,
    redisSubscriber,
    relay: relayClient,
  });
  (app as any).ws('/ws', (ws, req, next) => webSocketNode.acceptConnection(ws, req, next));
  logger.log('verbose', 'Configured WebSocket endpoints');

  app.use((req: Request, res: Response, next: NextFunction) => {
    const err = new RoutingError('Not Found');
    err.status = 404;
    next(err);
  });

  app.use((error: RoutingError | any, req: Request, res: Response, next: NextFunction) => {
    res.status(error.status || 500);
    res.json({ ...error });
  });

  return app;
};

export default createApp;
