import {
  AnchorProvider,
  BorshAccountsCoder,
  BorshEventCoder,
  BorshInstructionCoder,
  Idl,
  Program,
  Wallet,
} from '@project-serum/anchor';
import { Commitment, Connection, Keypair, PublicKey } from '@solana/web3.js';

import { Order, OrderSide } from '../models';
import {
  GalacticMarketPlaceEventType,
  GmLogEvent,
  RegisteredCurrency,
} from '../types';
import { GmpClientService } from './GmpClientService';
import { getGmLogsIDL } from '../utils';
import { GmLogs } from '../types';

/**
 * Listens to events emitted by the on-chain program and will call the registered
 * onEvent() callback function for each event.
 *
 * @param connection Solana connection
 * @param programId The Galactic Marketplace program PublicKey
 * @param commitment Optional Solana commitment level, defaults the `connection` commitment level
 */
export class GmpEventService {
  protected wallet: Wallet;
  protected connection: Connection;
  protected programId: PublicKey;
  protected commitment: Commitment;
  protected idl: Idl;
  protected provider: AnchorProvider;
  protected program: Program;
  protected registeredCurrencyInfo: {
    [key: string]: RegisteredCurrency;
  } = {};
  protected onEvent: (
    eventType: GalacticMarketPlaceEventType,
    order: Order,
    slotContext: number
  ) => void;

  constructor(
    connection: Connection,
    programId: PublicKey,
    commitment?: Commitment
  ) {
    this.wallet = new Wallet(new Keypair());
    this.connection = connection;
    this.programId = programId;
    this.commitment = commitment || connection.commitment;

    this.handleOrderCreated = this.handleOrderCreated.bind(this);
    this.handleOrderExchanged = this.handleOrderExchanged.bind(this);
    this.handleOrderCanceled = this.handleOrderCanceled.bind(this);
  }

  async initialize(): Promise<void> {
    this.idl = getGmLogsIDL(this.programId) as Idl;

    this.provider = new AnchorProvider(this.connection, this.wallet, {
      commitment: this.commitment,
    });

    this.program = new Program(this.idl, this.programId, this.provider, {
      instruction: new BorshInstructionCoder(this.idl),
      accounts: new BorshAccountsCoder(this.idl),
      state: null,
      events: new BorshEventCoder(this.idl),
    });

    await this.setCurrencyInfo();

    this.program.addEventListener(
      GmLogs.InitializeMemo,
      this.handleOrderCreated
    );
    this.program.addEventListener(
      GmLogs.ExchangeMemo,
      this.handleOrderExchanged
    );
    this.program.addEventListener(
      GmLogs.CancelOrderMemo,
      this.handleOrderCanceled
    );
    this.program.addEventListener(
      GmLogs.RegisterCurrencyMemo,
      this.handleCurrencyRegistered
    );
  }

  setEventHandler(
    handler: (
      eventType: GalacticMarketPlaceEventType,
      order: Order,
      slotContext: number
    ) => void
  ): void {
    this.onEvent = handler;
  }

  protected async setCurrencyInfo(): Promise<void> {
    const gmpClientService = new GmpClientService();

    const registeredCurrencyInfo =
      await gmpClientService.getAllRegisteredCurrencyInfo(
        this.connection,
        this.programId,
        true
      );

    for (const info of registeredCurrencyInfo) {
      this.registeredCurrencyInfo[info.mint] = info;
    }
  }

  protected getParsedOrderFromEvent(event: GmLogEvent): Order | null {
    const currencyInfo =
      this.registeredCurrencyInfo[event.currencyMint.toString()];

    if (!currencyInfo) return null;

    const { decimals } = currencyInfo;

    return new Order({
      id: event.orderId.toString(),
      orderType: event.orderSide === 0 ? OrderSide.Buy : OrderSide.Sell,
      orderMint: event.assetMint.toString(),
      currencyMint: event.currencyMint.toString(),
      price: event.price.toNumber() / 10 ** decimals,
      orderQtyRemaining: event.orderRemainingQty.toNumber(),
      orderOriginationQty: event.orderOriginationQty.toNumber(),
      owner: event.orderInitializerPubkey.toString(),
      ownerAssetTokenAccount: event.initializerAssetTokenAccount.toString(),
      ownerCurrencyTokenAccount:
        event.initializerCurrencyTokenAccount.toString(),
      createdAt: event.createdAtTimestamp.toNumber(),
    });
  }

  protected handleOrderCreated(event: GmLogEvent, slotContext: number): void {
    this.onEvent(
      GalacticMarketPlaceEventType.orderAdded,
      this.getParsedOrderFromEvent(event),
      slotContext
    );
  }

  protected handleOrderExchanged(event: GmLogEvent, slotContext: number): void {
    this.onEvent(
      GalacticMarketPlaceEventType.orderModified,
      this.getParsedOrderFromEvent(event),
      slotContext
    );
  }

  protected handleOrderCanceled(event: GmLogEvent, slotContext: number): void {
    this.onEvent(
      GalacticMarketPlaceEventType.orderRemoved,
      this.getParsedOrderFromEvent(event),
      slotContext
    );
  }

  protected async handleCurrencyRegistered(): Promise<void> {
    await this.setCurrencyInfo();
  }
}