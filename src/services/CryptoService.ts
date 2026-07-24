// =============================================================================
// GEMSTREAM — src/services/CryptoService.ts
// Production Implementation v1.1.0
//
// GOVERNING ARCHITECTURE (see SYSTEM_ARCHITECTURE.md §6):
//   Network:      Polygon PoS Mainnet (Chain ID: 137) / Amoy Testnet (80002)
//   Token:        ERC-20 USDT @ 0xc2132D05D31c914a87C6611C10748AEb04B58e8F
//   Web3 Engine:  Ethers.js v6
//   Hot Wallet:   Platform EOA — private key loaded via getEnv() (never logged)
//   Gas:          Platform pays native MATIC gas as cost of business (§6)
//
// AXIOM COMPLIANCE:
//   Axiom 2.2 — All USDT amounts use BigInt end-to-end. No Number math.
//
// SECURITY:
//   HOT_WALLET_PRIVATE_KEY is read exclusively through the Zod-validated env
//   module. The key is passed once to ethers.Wallet and never stored separately
//   or emitted in logs/errors.
// =============================================================================

import { ethers, type ContractTransactionResponse, type TransactionReceipt } from "ethers";
import { PrismaClient } from "@prisma/client";
import { getEnv } from "../config/env";

// =============================================================================
// CONSTANTS
// =============================================================================

const POLYGON_USDT_ADDRESS = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

const ERC20_TRANSFER_ABI: readonly string[] = [
  "function transfer(address to, uint256 amount) returns (bool)",
] as const;

const MAX_BROADCAST_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_500;
const FEE_ESCALATION_FACTOR = 1.25;

// =============================================================================
// CUSTOM ERROR CLASSES
// =============================================================================

export class InvalidWalletAddressError extends Error {
  public readonly code = "INVALID_WALLET_ADDRESS" as const;
  constructor(address: string, reason: string) {
    super(`[CryptoService] InvalidWalletAddressError: "${address}" — ${reason}`);
    this.name = "InvalidWalletAddressError";
    Object.setPrototypeOf(this, InvalidWalletAddressError.prototype);
  }
}

export class PayoutBroadcastError extends Error {
  public readonly code = "PAYOUT_BROADCAST_FAILED" as const;
  public readonly originalError: unknown;

  constructor(payoutLogId: string, reason: string, originalError: unknown) {
    super(`[CryptoService] PayoutBroadcastError for PayoutLog ${payoutLogId}: ${reason}`);
    this.name = "PayoutBroadcastError";
    this.originalError = originalError;
    Object.setPrototypeOf(this, PayoutBroadcastError.prototype);
  }
}

// =============================================================================
// INPUT / OUTPUT DTOs
// =============================================================================

export interface ProcessPayoutInput {
  payoutLogId: string;
  destinationWallet: string;
  /** USDT micro-units (6 decimals) as string — converted to BigInt internally. */
  usdtAmountUnits: string;
}

export interface ProcessPayoutResult {
  txHash: string;
  confirmedBlock: number;
  payoutLogId: string;
}

/** On-chain payout result — transactionHash is persisted to PayoutLog for audit. */
export interface PayoutResult {
  transactionHash: string;
  confirmedBlock: number;
}

// =============================================================================
// CLASS: CryptoService
// =============================================================================

export class CryptoService {
  private provider: ethers.JsonRpcProvider | null = null;
  private hotWallet: ethers.Wallet | null = null;
  private usdtContract: ethers.Contract | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    provider?: ethers.JsonRpcProvider,
    wallet?: ethers.Wallet,
    contract?: ethers.Contract
  ) {
    if (provider && wallet && contract) {
      this.provider = provider;
      this.hotWallet = wallet;
      this.usdtContract = contract;
    } else if (provider || wallet || contract) {
      throw new Error(
        "[CryptoService] Partial injection is not supported — provide all three ethers mocks or none."
      );
    }
  }

  // ===========================================================================
  // PRIVATE: Chain initialisation & validation
  // ===========================================================================

  private ensureChainReady(): {
    provider: ethers.JsonRpcProvider;
    hotWallet: ethers.Wallet;
    usdtContract: ethers.Contract;
  } {
    if (this.provider && this.hotWallet && this.usdtContract) {
      return {
        provider: this.provider,
        hotWallet: this.hotWallet,
        usdtContract: this.usdtContract,
      };
    }

    const env = getEnv();
    this.provider = new ethers.JsonRpcProvider(env.POLYGON_RPC_URL);
    // Private key is consumed by ethers.Wallet only — never retained as a field.
    this.hotWallet = new ethers.Wallet(env.HOT_WALLET_PRIVATE_KEY, this.provider);
    this.usdtContract = new ethers.Contract(
      POLYGON_USDT_ADDRESS,
      ERC20_TRANSFER_ABI,
      this.hotWallet
    );

    return {
      provider: this.provider,
      hotWallet: this.hotWallet,
      usdtContract: this.usdtContract,
    };
  }

  private validateDestinationWallet(address: string): void {
    if (!ethers.isAddress(address)) {
      throw new InvalidWalletAddressError(
        address,
        "not a valid EVM address (failed ethers.isAddress check)"
      );
    }

    if (address.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      throw new InvalidWalletAddressError(
        address,
        "zero address (0x000...000) cannot receive tokens — funds would be permanently lost"
      );
    }
  }

  private parseAmount(amount: string): bigint {
    if (!/^\d+$/.test(amount)) {
      throw new Error(
        `[CryptoService] Amount must be a non-negative integer string (micro-units). Received: "${amount}"`
      );
    }
    const value = BigInt(amount);
    if (value <= 0n) {
      throw new Error(`[CryptoService] Amount must be greater than zero. Received: "${amount}"`);
    }
    return value;
  }

  /** Pending nonce includes mempool transactions — prevents nonce collisions. */
  private async getPendingNonce(
    provider: ethers.JsonRpcProvider,
    walletAddress: string
  ): Promise<number> {
    return provider.getTransactionCount(walletAddress, "pending");
  }

  private async getEscalatedFeeData(
    provider: ethers.JsonRpcProvider,
    attempt: number
  ): Promise<{
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    gasPrice?: bigint;
  }> {
    const feeData = await provider.getFeeData();
    const multiplier = BigInt(Math.round(FEE_ESCALATION_FACTOR ** attempt * 100));
    const scale = (value: bigint | null): bigint | undefined => {
      if (value == null) return undefined;
      return (value * multiplier) / 100n;
    };

    if (feeData.maxFeePerGas != null) {
      return {
        maxFeePerGas: scale(feeData.maxFeePerGas),
        maxPriorityFeePerGas: scale(feeData.maxPriorityFeePerGas),
      };
    }

    return { gasPrice: scale(feeData.gasPrice) };
  }

  private isRetryableBroadcastError(error: unknown): boolean {
    const message =
      error instanceof Error
        ? `${error.name} ${error.message}`.toLowerCase()
        : String(error).toLowerCase();

    const retryablePatterns = [
      "nonce too low",
      "replacement transaction underpriced",
      "already known",
      "timeout",
      "timed out",
      "network",
      "econnreset",
      "etimedout",
      "rate limit",
      "429",
      "503",
      "server error",
      "fee cap less than block base fee",
      "max fee per gas less than block base fee",
      "underpriced",
      "gas price",
      "intrinsic gas too low",
    ];

    return retryablePatterns.some((pattern) => message.includes(pattern));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Submits an ERC-20 transfer with pending-nonce tracking and gas escalation retries.
   */
  private async broadcastTransferWithRetry(
    toAddress: string,
    amount: bigint
  ): Promise<ContractTransactionResponse> {
    const { provider, hotWallet, usdtContract } = this.ensureChainReady();
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_BROADCAST_RETRIES; attempt++) {
      try {
        const nonce = await this.getPendingNonce(provider, hotWallet.address);
        const feeOverrides = await this.getEscalatedFeeData(provider, attempt);

        return (await usdtContract.transfer(toAddress, amount, {
          nonce,
          ...feeOverrides,
        })) as ContractTransactionResponse;
      } catch (error) {
        lastError = error;
        const canRetry = attempt < MAX_BROADCAST_RETRIES - 1 && this.isRetryableBroadcastError(error);
        if (!canRetry) break;

        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
        console.warn(
          `[CryptoService] Broadcast attempt ${attempt + 1}/${MAX_BROADCAST_RETRIES} failed — ` +
            `retrying in ${delay}ms:`,
          error instanceof Error ? error.message : error
        );
        await this.sleep(delay);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async confirmTransfer(tx: ContractTransactionResponse): Promise<TransactionReceipt> {
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      throw new Error(
        receipt
          ? `EVM reversion in block ${receipt.blockNumber} (receipt.status === 0)`
          : "tx.wait() resolved with a null receipt"
      );
    }
    return receipt;
  }

  // ===========================================================================
  // PUBLIC METHOD: payout
  // ===========================================================================

  /**
   * Sends USDT (ERC-20) on Polygon to `toAddress`.
   *
   * @param toAddress - EVM recipient address (validated, zero-address rejected)
   * @param amount    - USDT micro-units as integer string (e.g. "50000000" = $50.00)
   * @returns transactionHash for PayoutLog audit + confirmed block number
   */
  async payout(toAddress: string, amount: string): Promise<PayoutResult> {
    this.validateDestinationWallet(toAddress);
    const transferAmount = this.parseAmount(amount);

    const tx = await this.broadcastTransferWithRetry(toAddress, transferAmount);
    const receipt = await this.confirmTransfer(tx);

    return {
      transactionHash: tx.hash,
      confirmedBlock: receipt.blockNumber,
    };
  }

  // ===========================================================================
  // PUBLIC METHOD: processPayout
  // ===========================================================================

  async processPayout(input: ProcessPayoutInput): Promise<ProcessPayoutResult> {
    const { payoutLogId, destinationWallet, usdtAmountUnits } = input;

    this.validateDestinationWallet(destinationWallet);
    const transferAmount = this.parseAmount(usdtAmountUnits);

    try {
      const tx = await this.broadcastTransferWithRetry(destinationWallet, transferAmount);

      // Persist txHash immediately — crash-safe anchor for dashboard tracking.
      await this.prisma.payoutLog.update({
        where: { id: payoutLogId },
        data: {
          status: "PROCESSING",
          txHash: tx.hash,
        },
      });

      const receipt = await this.confirmTransfer(tx);

      await this.prisma.payoutLog.update({
        where: { id: payoutLogId },
        data: {
          status: "COMPLETED",
          confirmedBlock: receipt.blockNumber,
        },
      });

      return {
        txHash: receipt.hash,
        confirmedBlock: receipt.blockNumber,
        payoutLogId,
      };
    } catch (error) {
      if (error instanceof PayoutBroadcastError) {
        throw error;
      }

      try {
        await this.prisma.payoutLog.update({
          where: { id: payoutLogId },
          data: { status: "FAILED" },
        });
      } catch (dbError) {
        console.error(
          `[CryptoService] CRITICAL: Failed to update PayoutLog ${payoutLogId} to FAILED.`,
          dbError
        );
      }

      throw new PayoutBroadcastError(
        payoutLogId,
        error instanceof Error ? error.message : "unknown error",
        error
      );
    }
  }
}
