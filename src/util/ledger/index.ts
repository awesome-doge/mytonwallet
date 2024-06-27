import { StatusCodes } from '@ledgerhq/errors';
import TransportWebHID from '@ledgerhq/hw-transport-webhid';
import TransportWebUSB from '@ledgerhq/hw-transport-webusb';
import { loadStateInit } from '@ton/core';
import type { TonPayloadFormat } from '@ton-community/ton-ledger';
import { TonTransport } from '@ton-community/ton-ledger';
import { Address } from '@ton/core/dist/address/Address';
import { Builder } from '@ton/core/dist/boc/Builder';
import { Cell } from '@ton/core/dist/boc/Cell';
import { SendMode } from '@ton/core/dist/types/SendMode';

import type { ApiTonConnectProof } from '../../api/tonConnect/types';
import type {
  ApiDappTransfer,
  ApiLocalTransactionParams,
  ApiNetwork,
  ApiSignedTransfer,
  ApiSubmitTransferOptions,
  Workchain,
} from '../../api/types';
import type { LedgerWalletInfo } from './types';

import { ONE_TON, TONCOIN_SLUG } from '../../config';
import { callApi } from '../../api';
import {
  DEFAULT_IS_BOUNCEABLE,
  STAKE_COMMENT,
  TOKEN_TRANSFER_TONCOIN_AMOUNT,
  TOKEN_TRANSFER_TONCOIN_FORWARD_AMOUNT,
  TRANSFER_TIMEOUT_SEC,
  UNSTAKE_COMMENT,
  WALLET_IS_BOUNCEABLE,
  WORKCHAIN,
} from '../../api/blockchains/ton/constants';
import { ApiUserRejectsError, handleServerError } from '../../api/errors';
import { parseAccountId } from '../account';
import { logDebugError } from '../logs';
import { pause } from '../schedulers';
import { isValidLedgerComment } from './utils';

const CHAIN = 0; // workchain === -1 ? 255 : 0;
const VERSION = 'v4R2';
const ATTEMPTS = 10;
const PAUSE = 125;
const IS_BOUNCEABLE = false;

let transport: TransportWebHID | TransportWebUSB | undefined;
let tonTransport: TonTransport | undefined;

export async function importLedgerWallet(network: ApiNetwork, accountIndex: number) {
  const walletInfo = await getLedgerWalletInfo(network, accountIndex);
  return callApi('importLedgerWallet', network, walletInfo);
}

export async function reconnectLedger() {
  try {
    if (tonTransport && await tonTransport?.isAppOpen()) {
      return true;
    }
  } catch {
    // do nothing
  }

  return await connectLedger() && await waitLedgerTonApp();
}

export async function connectLedger() {
  try {
    if (await TransportWebHID.isSupported()) {
      transport = await connectHID();
    } else if (await TransportWebUSB.isSupported()) {
      transport = await connectUSB();
    } else {
      logDebugError('connectLedger: HID and/or USB are not supported');
      return false;
    }
    tonTransport = new TonTransport(transport);
    return true;
  } catch (err) {
    logDebugError('connectLedger', err);
    return false;
  }
}

function waitLedgerTonAppDeadline(): Promise<boolean> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(false);
    }, PAUSE * ATTEMPTS);
  });
}

export async function checkTonApp() {
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const isTonOpen = await tonTransport!.isAppOpen();

      if (isTonOpen) {
        // Workaround for Ledger S, this is a way to check if it is unlocked.
        // There will be an error with code 0x530c
        await tonTransport?.getAddress(getLedgerAccountPathByIndex(0));

        return true;
      }
    } catch (err: any) {
      if (!err?.message.includes('0x530c')) {
        logDebugError('waitLedgerTonApp', err);
      }
    }

    await pause(PAUSE);
  }

  return false;
}

export function waitLedgerTonApp() {
  return Promise.race([
    checkTonApp(),
    waitLedgerTonAppDeadline(),
  ]);
}

async function connectHID() {
  for (let i = 0; i < ATTEMPTS; i++) {
    const [device] = await TransportWebHID.list();

    if (!device) {
      await TransportWebHID.create();
      await pause(PAUSE);
      continue;
    }

    if (device.opened) {
      return new TransportWebHID(device);
    } else {
      return TransportWebHID.open(device);
    }
  }

  throw new Error('Failed to connect');
}

async function connectUSB() {
  for (let i = 0; i < ATTEMPTS; i++) {
    const [device] = await TransportWebUSB.list();

    if (!device) {
      await TransportWebUSB.create();
      await pause(PAUSE);
      continue;
    }

    if (device.opened) {
      return (await TransportWebUSB.openConnected()) ?? (await TransportWebUSB.request());
    } else {
      return TransportWebUSB.open(device);
    }
  }

  throw new Error('Failed to connect');
}

export async function submitLedgerStake(
  accountId: string,
  amount: bigint,
  fee?: bigint,
) {
  const { network } = parseAccountId(accountId);
  const address = await callApi('fetchAddress', accountId);
  const backendState = await callApi('fetchBackendStakingState', address!, true);

  const poolAddress = toBase64Address(backendState!.nominatorsPool.address, true, network);

  const result = await submitLedgerTransfer({
    accountId,
    password: '',
    toAddress: poolAddress,
    amount,
    comment: STAKE_COMMENT,
    fee,
  }, TONCOIN_SLUG, { type: 'stake' });

  if (result) {
    await callApi('updateAccountMemoryCache', accountId, address!, { stakedAt: Date.now() });
  }

  await callApi('onStakingChangeExpected');

  return result;
}

export async function submitLedgerUnstake(accountId: string) {
  const { network } = parseAccountId(accountId);
  const address = await callApi('fetchAddress', accountId);
  const backendState = await callApi('fetchBackendStakingState', address!, true);

  const poolAddress = toBase64Address(backendState!.nominatorsPool.address, true, network);
  const result = await submitLedgerTransfer({
    accountId,
    password: '',
    toAddress: poolAddress,
    amount: ONE_TON,
    comment: UNSTAKE_COMMENT,
  }, TONCOIN_SLUG, { type: 'unstakeRequest' });

  await callApi('onStakingChangeExpected');

  return result;
}

export async function submitLedgerTransfer(
  options: ApiSubmitTransferOptions,
  slug: string,
  localTransactionParams?: Partial<ApiLocalTransactionParams>,
) {
  const {
    accountId, tokenAddress, comment, fee,
  } = options;
  let { toAddress, amount } = options;
  const { network } = parseAccountId(accountId);

  await callApi('waitLastTransfer', accountId);

  const fromAddress = await callApi('fetchAddress', accountId);

  const [path, walletInfo] = await Promise.all([
    getLedgerAccountPath(accountId),
    callApi('getWalletInfo', network, fromAddress!),
  ]);

  const { seqno, balance } = walletInfo!;

  let payload: TonPayloadFormat | undefined;
  const parsedAddress = Address.parseFriendly(toAddress);
  let isBounceable = parsedAddress.isBounceable;
  const normalizedAddress = parsedAddress.address.toString({ urlSafe: true, bounceable: DEFAULT_IS_BOUNCEABLE });

  if (tokenAddress) {
    ({ toAddress, amount, payload } = await buildLedgerTokenTransfer(
      network, tokenAddress, fromAddress!, toAddress, amount, comment,
    ));
    isBounceable = true;
  } else if (comment) {
    if (isValidLedgerComment(comment)) {
      payload = { type: 'comment', text: comment };
    } else {
      throw Error('Unsupported format');
    }
  }

  const isFullTonBalance = !tokenAddress && balance === amount;

  const sendMode = isFullTonBalance
    ? SendMode.CARRY_ALL_REMAINING_BALANCE
    : SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS;

  try {
    const signedCell = await tonTransport!.signTransaction(path, {
      to: Address.parse(toAddress),
      sendMode,
      seqno: seqno!,
      timeout: getTransferExpirationTime(),
      bounce: isBounceable,
      amount: BigInt(amount),
      payload,
    });

    const message: ApiSignedTransfer = {
      base64: signedCell.toBoc().toString('base64'),
      seqno: seqno!,
      params: {
        amount: options.amount,
        fromAddress: fromAddress!,
        toAddress: normalizedAddress,
        comment,
        fee: fee!,
        slug,
        ...localTransactionParams,
      },
    };

    return await callApi('sendSignedTransferMessage', accountId, message);
  } catch (error) {
    logDebugError('submitLedgerTransfer', error);
    return undefined;
  }
}

export async function buildLedgerTokenTransfer(
  network: ApiNetwork,
  tokenAddress: string,
  fromAddress: string,
  toAddress: string,
  amount: bigint,
  comment?: string,
) {
  const tokenWalletAddress = await callApi('resolveTokenWalletAddress', network, fromAddress, tokenAddress);
  const realTokenAddress = await callApi('resolveTokenMinterAddress', network, tokenWalletAddress!);
  if (tokenAddress !== realTokenAddress) {
    throw new Error('Invalid contract');
  }

  // eslint-disable-next-line no-null/no-null
  const forwardPayload = comment ? buildCommentPayload(comment) : null;

  const payload: TonPayloadFormat = {
    type: 'jetton-transfer',
    queryId: 0n,
    amount,
    destination: Address.parse(toAddress),
    responseDestination: Address.parse(fromAddress),
    // eslint-disable-next-line no-null/no-null
    customPayload: null,
    forwardAmount: TOKEN_TRANSFER_TONCOIN_FORWARD_AMOUNT,
    forwardPayload,
  };

  return {
    amount: TOKEN_TRANSFER_TONCOIN_AMOUNT,
    toAddress: tokenWalletAddress!,
    payload,
  };
}

function buildCommentPayload(comment: string) {
  return new Builder()
    .storeUint(0, 32)
    .storeStringTail(comment)
    .endCell();
}

export async function signLedgerTransactions(
  accountId: string, messages: ApiDappTransfer[], seqno?: number,
): Promise<ApiSignedTransfer[]> {
  await callApi('waitLastTransfer', accountId);

  const [path, fromAddress] = await Promise.all([
    getLedgerAccountPath(accountId),
    callApi('fetchAddress', accountId),
  ]);

  if (!seqno) {
    seqno = await callApi('getWalletSeqno', accountId);
  }

  const preparedOptions = messages.map((message, index) => {
    const {
      toAddress, amount, payload, stateInit: stateInitBase64,
    } = message;

    let isBounceable = Address.isFriendly(toAddress)
      ? Address.parseFriendly(toAddress).isBounceable
      : DEFAULT_IS_BOUNCEABLE;
    let ledgerPayload: TonPayloadFormat | undefined;

    switch (payload?.type) {
      case 'comment': {
        const { comment } = payload;
        if (isValidLedgerComment(comment)) {
          ledgerPayload = { type: 'comment', text: payload.comment };
        } else {
          throw Error('Unsupported format');
        }
        break;
      }
      case undefined: {
        ledgerPayload = undefined;
        break;
      }
      case 'nft:transfer': {
        const {
          queryId,
          newOwner,
          responseDestination,
          customPayload,
          forwardAmount,
          forwardPayload,
        } = payload;

        isBounceable = true;
        ledgerPayload = {
          type: 'nft-transfer',
          queryId: BigInt(queryId),
          newOwner: Address.parse(newOwner),
          responseDestination: Address.parse(responseDestination),
          // eslint-disable-next-line no-null/no-null
          customPayload: customPayload ? Cell.fromBase64(customPayload) : null,
          forwardAmount: BigInt(forwardAmount),
          // eslint-disable-next-line no-null/no-null
          forwardPayload: forwardPayload ? Cell.fromBase64(forwardPayload) : null,
        };
        break;
      }
      case 'tokens:transfer': {
        const {
          queryId,
          amount: jettonAmount,
          destination,
          responseDestination,
          customPayload,
          forwardAmount,
          forwardPayload,
        } = payload;

        isBounceable = true;
        ledgerPayload = {
          type: 'jetton-transfer',
          queryId: BigInt(queryId),
          amount: BigInt(jettonAmount),
          destination: Address.parse(destination),
          responseDestination: Address.parse(responseDestination),
          // eslint-disable-next-line no-null/no-null
          customPayload: customPayload ? Cell.fromBase64(customPayload) : null,
          forwardAmount: BigInt(forwardAmount),
          // eslint-disable-next-line no-null/no-null
          forwardPayload: forwardPayload ? Cell.fromBase64(forwardPayload) : null,
        };
        break;
      }
      case 'unknown':
      default: {
        throw Error('Unsupported format');
      }
    }

    const stateInit = stateInitBase64 ? loadStateInit(
      Cell.fromBase64(stateInitBase64).asSlice(),
    ) : undefined;

    return {
      to: Address.parse(toAddress),
      sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
      seqno: seqno! + index,
      timeout: getTransferExpirationTime(),
      bounce: isBounceable,
      amount: BigInt(amount),
      payload: ledgerPayload,
      stateInit,
    };
  });

  const signedMessages: ApiSignedTransfer[] = [];

  const attempts = ATTEMPTS + preparedOptions.length;
  let index = 0;
  let attempt = 0;

  while (index < preparedOptions.length && attempt < attempts) {
    const options = preparedOptions[index];
    const message = messages[index];

    try {
      const base64 = (await tonTransport!.signTransaction(path, options)).toBoc().toString('base64');
      signedMessages.push({
        base64,
        seqno: options.seqno,
        params: {
          amount: message.amount,
          fromAddress: fromAddress!,
          toAddress: message.toAddress,
          comment: message.payload?.type === 'comment' ? message.payload.comment : undefined,
          fee: 0n,
          slug: TONCOIN_SLUG,
        },
      });
      index++;
    } catch (err: any) {
      if (err?.statusCode === StatusCodes.CONDITIONS_OF_USE_NOT_SATISFIED) {
        throw new ApiUserRejectsError();
      }
      logDebugError('signLedgerTransactions', err);
    }
    attempt++;
  }

  return signedMessages;
}

export async function signLedgerProof(accountId: string, proof: ApiTonConnectProof): Promise<string> {
  const path = await getLedgerAccountPath(accountId);

  const { timestamp, domain, payload } = proof;

  const result = await tonTransport!.getAddressProof(path, {
    domain,
    timestamp,
    payload: Buffer.from(payload),
  });
  return result.signature.toString('base64');
}

export async function getNextLedgerWallets(
  network: ApiNetwork,
  lastExistingIndex = -1,
  alreadyImportedAddresses: string[] = [],
) {
  const result: LedgerWalletInfo[] = [];
  let index = lastExistingIndex + 1;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const walletInfo = await getLedgerWalletInfo(network, index);

      if (alreadyImportedAddresses.includes(walletInfo.address)) {
        index += 1;
        continue;
      }

      if (walletInfo.balance !== 0n) {
        result.push(walletInfo);
        index += 1;
        continue;
      }

      if (!result.length) {
        result.push(walletInfo);
      }

      return result;
    }
  } catch (err) {
    return handleServerError(err);
  }
}

export async function getLedgerWalletInfo(network: ApiNetwork, accountIndex: number): Promise<LedgerWalletInfo> {
  const { address, publicKey } = await getLedgerWalletAddress(accountIndex);
  const balance = (await callApi('getWalletBalance', network, address))!;

  return {
    index: accountIndex,
    address,
    publicKey: publicKey!.toString('hex'),
    balance,
    version: VERSION,
    driver: 'HID',
    deviceId: transport!.deviceModel?.id,
    deviceName: transport!.deviceModel?.productName,
  };
}

export function getLedgerWalletAddress(index: number, isTestnet?: boolean) {
  const path = getLedgerAccountPathByIndex(index, isTestnet);

  return tonTransport!.getAddress(path, {
    chain: CHAIN,
    bounceable: WALLET_IS_BOUNCEABLE,
  });
}

export async function verifyAddress(accountId: string) {
  const path = await getLedgerAccountPath(accountId);

  await tonTransport!.validateAddress(path, { bounceable: IS_BOUNCEABLE });
}

async function getLedgerAccountPath(accountId: string) {
  const accountInfo = await callApi('fetchAccount', accountId);
  const index = accountInfo!.ledger!.index;

  return getLedgerAccountPathByIndex(index);
}

function getLedgerAccountPathByIndex(index: number, isTestnet?: boolean, workchain: Workchain = WORKCHAIN) {
  const network = isTestnet ? 1 : 0;
  const chain = workchain === -1 ? 255 : 0;
  return [44, 607, network, chain, index, 0];
}

function getTransferExpirationTime() {
  return Math.floor(Date.now() / 1000 + TRANSFER_TIMEOUT_SEC);
}

function toBase64Address(address: Address | string, isBounceable = DEFAULT_IS_BOUNCEABLE, network?: ApiNetwork) {
  if (typeof address === 'string') {
    address = Address.parse(address);
  }
  return address.toString({
    urlSafe: true,
    bounceable: isBounceable,
    testOnly: network === 'testnet',
  });
}
