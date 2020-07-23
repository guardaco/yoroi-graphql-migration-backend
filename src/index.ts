import config from "config";
import http from "http";
import express from "express";
import * as websockets from "ws";
import { Request, Response } from "express";

import { Pool } from "pg";

// eslint-disable-next-line
const semverCompare = require("semver-compare");

import { connectionHandler} from "./ws-server"; 
import { applyMiddleware, applyRoutes, contentTypeHeaders, graphqlEndpoint, Route } from "./utils";
import * as utils from "./utils";
import * as middleware from "./middleware";

import { askBestBlock } from "./services/bestblock";
import { askUtxoForAddresses } from "./services/utxoForAddress";
import { askBlockNumByHash, askBlockNumByTxHash, askTransactionHistory } from "./services/transactionHistory";
import { askFilterUsedAddresses } from "./services/filterUsedAddress";
import { askUtxoSumForAddresses } from "./services/utxoSumForAddress";
import { handleSignedTx } from "./services/signedTransaction";
import { BodyRow, askTxBodies } from "./services/txBodies";

import { HealthChecker } from "./HealthChecker";


const pool = new Pool({ user: config.get("db.user")
  , host: config.get("db.host")
  , database: config.get("db.database")
  , password: config.get("db.password")});

const healthChecker = new HealthChecker(askBestBlock);

const router = express();

const middlewares = [ middleware.handleCors
  , middleware.handleBodyRequestParsing 
  , middleware.handleCompression 
];

applyMiddleware(middlewares, router);



const port:number= config.get("server.port");
const addressesRequestLimit:number = config.get("server.addressRequestLimit");
const apiResponseLimit:number = config.get("server.apiResponseLimit"); 
const txsHashesRequestLimit:number = config.get("server.txsHashesRequestLimit");

const bestBlock = async (req: Request, res: Response) => {
  const result = await askBestBlock();
  switch(result.kind) {
  case "ok": {
    const cardano = result.value;
    res.send({
      epoch: cardano.currentEpoch.number,
      slot: cardano.currentEpoch.blocks[0].slotInEpoch ,
      hash: cardano.currentEpoch.blocks[0].hash,
      height: cardano.currentEpoch.blocks[0].number,
    });

    return;
  }
  case "error":
    throw new Error(result.errMsg);
    return;
  default: return utils.assertNever(result);
  }
};

const utxoForAddresses = async (req: Request, res: Response) => {
  if(!req.body || !req.body.addresses) {
    throw new Error("error, no addresses.");
    return;
  }
  const verifiedAddresses = utils.validateAddressesReq(addressesRequestLimit
    , req.body.addresses);
  switch(verifiedAddresses.kind){
  case "ok": {
    const result = await askUtxoForAddresses(verifiedAddresses.value);
    switch(result.kind)
    {
    case "ok":{
      const utxos = result.value.map( utxo => 
        ({
          utxo_id: `${utxo.txHash}:${utxo.index}`,
          tx_hash: utxo.txHash,
          tx_index: utxo.index,
          receiver: utxo.address,
          amount: utxo.value,
          block_num: utxo.transaction.block.number,
        }));
      res.send(utxos);
      return;
    }
    case "error":
      throw new Error(result.errMsg);
      return;
    default: return utils.assertNever(result);

    }
  }
  case "error":
    throw new Error(verifiedAddresses.errMsg);
    return;
  default: return utils.assertNever(verifiedAddresses);
  }
};


const filterUsedAddresses = async (req: Request, res: Response) => {
  if(!req.body || !req.body.addresses) {
    throw new Error("error, no addresses.");
    return;
  }
  const verifiedAddresses = utils.validateAddressesReq(addressesRequestLimit
    , req.body.addresses);
  switch(verifiedAddresses.kind){
  case "ok": {
    const result = await askFilterUsedAddresses(verifiedAddresses.value);
    switch(result.kind){
    case "ok":{
      const resultSet = new Set(result.value.flatMap( tx => [tx.inputs, tx.outputs]).flat().map(x => x.address));
      const verifiedSet = new Set(verifiedAddresses.value);
      const intersection = new Set();
      for (const elem of resultSet)
        if(verifiedSet.has(elem))
          intersection.add(elem);
      res.send([...intersection]);
      return;}
    case "error":
      throw new Error(result.errMsg);
      return;
    default: return utils.assertNever(result);
    }
    return;
  }
  case "error":
    throw new Error(verifiedAddresses.errMsg);
    return;
  default: return utils.assertNever(verifiedAddresses);
  }
};



const utxoSumForAddresses = async (req:  Request, res:Response) => {
  if(!req.body || !req.body.addresses) {
    throw new Error("error, no addresses.");
    return;
  }
  const verifiedAddresses = utils.validateAddressesReq(addressesRequestLimit
    , req.body.addresses);
  switch(verifiedAddresses.kind){
  case "ok":  {
    const result = await askUtxoSumForAddresses(verifiedAddresses.value);
    switch(result.kind) {
    case "ok":
      res.send({ sum: result.value });
      return;
    case "error":
      throw new Error(result.errMsg);
      return;
    default: return utils.assertNever(result);  
    }
    return;
  }
  case "error":
    throw new Error(verifiedAddresses.errMsg);
    return;
  default: return utils.assertNever(verifiedAddresses);
  }
};

const txHistory = async (req: Request, res: Response) => {
  if(!req.body){
    throw new Error("error, no body");
    return;
  }
  const verifiedBody = utils.validateHistoryReq(addressesRequestLimit, apiResponseLimit, req.body);
  switch(verifiedBody.kind){
  case "ok": {
    const body = verifiedBody.value;
    const limit = body.limit || apiResponseLimit;
    const [referenceTx, referenceBlock] = (body.after && [body.after.tx, body.after.block]) || [];
    const referenceBestBlock = body.untilBlock;
    const untilBlockNum = await askBlockNumByHash(referenceBestBlock);
    const afterBlockNum = await askBlockNumByTxHash(referenceTx );

    if(untilBlockNum.kind === "error" && untilBlockNum.errMsg !== utils.errMsgs.noValue) {
      throw new Error("REFERENCE_BEST_BLOCK_MISMATCH");
      return;
    }
    if(afterBlockNum.kind === "error" && afterBlockNum.errMsg !== utils.errMsgs.noValue) {
      throw new Error("REFERENCE_TX_NOT_FOUND");
      return;
    }

    if(afterBlockNum.kind === "ok" && afterBlockNum.value.block.hash !== referenceBlock) {
      throw new Error("REFERENCE_BLOCK_MISMATCH");
      return;
    }

    const maybeTxs = await askTransactionHistory(pool, limit, body.addresses, afterBlockNum, untilBlockNum);
    switch(maybeTxs.kind) {
    case "ok":{
      const txs = maybeTxs.value.map( tx => ({
        hash: tx.hash,
        tx_ordinal: tx.txIndex,
        tx_state: "Successful", // graphql doesn't handle pending/failed txs
        last_update: tx.includedAt,
        block_num: tx.block.number,
        block_hash: tx.block.hash,
        time: tx.includedAt,
        epoch: tx.block.epochNo,
        slot: tx.block.slotNo,
        inputs: tx.inputs,
        outputs: tx.outputs
      }));

      res.send(txs);
      return;
    }
    case "error":
      throw new Error(maybeTxs.errMsg);
      return;
    default: return utils.assertNever(maybeTxs);
    }
    return;
  }
  case "error":
    throw new Error(verifiedBody.errMsg);
    return;
  default: return utils.assertNever(verifiedBody);
  }
};

const txBodies = async (req: Request, res: Response) => {
  if(!req.body.txsHashes || !(Array.isArray(req.body.txsHashes )))
    throw new Error("txBodies: must contain an array named txsHashes");

  if(req.body.txsHashes > txsHashesRequestLimit || req.body.txsHashes ===0)
    throw new Error(`txsHashes request length should be (0, ${txsHashesRequestLimit}]`);

  const results = await askTxBodies(pool, new Set(req.body.txsHashes));
  const resultsObj : { [key: string]: string } = {};
  results.forEach((row: BodyRow) => {
    resultsObj[row.hash] = row.body;
  });
  res.send(resultsObj);
};

const getStatus = async (req: Request, res:  Response) => {
  const mobilePlatformVersionPrefixes = ["android / ", "ios / ", "- /"];
  const clientVersionHeader = "yoroi-version";
  const minMobileVersion = "2.2.2";
  if(clientVersionHeader in req.headers){
    const rawVerString : string | string[] | undefined = req.headers[clientVersionHeader];
    let verString = "none / 0.0.0";
    if (typeof rawVerString === "string") 
      verString = rawVerString;
    if(Array.isArray(rawVerString))
      verString = rawVerString[0];

    for(const prefix of mobilePlatformVersionPrefixes){
      if (verString.includes(prefix)){
        const simVer = verString.split(" / ")[1];
        if (semverCompare(simVer, minMobileVersion) < 0){
          res.send({ isServerOk: true
            , isMaintenance: true });
          return;
        }
      }
    }
  }
  res.send({ isServerOk: true, isMaintenance: false }); 
};

const routes : Route[] = [ { path: "/v2/bestblock"
  , method: "get"
  , handler: bestBlock
}
, { path: "/v2/addresses/filterUsed"
  , method: "post"
  , handler: filterUsedAddresses
}
, { path: "/txs/utxoForAddresses"
  , method: "post"
  , handler: utxoForAddresses
}
, { path: "/txs/utxoSumForAddresses"
  , method: "post"
  , handler: utxoSumForAddresses
}
, { path: "/v2/txs/history"
  , method: "post"
  , handler: txHistory 
}
, { path: "/txs/signed"
  , method: "post"
  , handler: handleSignedTx
}
, { path: "/txs/txBodies"
  , method: "post"
  , handler: txBodies
}
, { path: "/v2/importerhealthcheck"
  , method: "get"
  , handler: async (req: Request, res: Response) => {
    const status = healthChecker.getStatus();
    if (status === "OK")
      res.send({ code: 200, message: "Importer is OK" });
    else if (status === "BLOCK_IS_STALE")
      res.send({ code: 200, message: "Importer seems OK. Not enough time has passed since last valid request." });
    else 
      throw new Error(status);
  }
}
, { path: "/status"
  , method: "get"
  , handler: getStatus
}
];

applyRoutes(routes, router);
router.use(middleware.logErrors);
router.use(middleware.errorHandler);

const server = http.createServer(router);

const wss = new websockets.Server({ server } );
wss.on("connection", connectionHandler());

server.listen(port, () =>
  console.log(`listening on ${port}...`)
);

