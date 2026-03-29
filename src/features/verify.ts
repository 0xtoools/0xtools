import * as https from 'https';

/**
 * Etherscan Verification - Verify contract signatures against Etherscan
 */

/** HTTP request timeout in milliseconds. */
const VERIFY_TIMEOUT_MS = 10_000;

/** Keep-alive HTTPS agent for Etherscan API requests. */
const etherscanAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

export interface EtherscanConfig {
  apiKey: string;
  network: 'mainnet' | 'sepolia' | 'polygon' | 'bsc';
}

export interface VerificationResult {
  contractAddress: string;
  verified: boolean;
  matches: {
    function: string;
    matched: boolean;
    etherscanSignature?: string;
  }[];
  mismatches: string[];
  additionalInEtherscan: string[];
}

export class EtherscanVerifier {
  private readonly API_ENDPOINTS: Record<string, string> = {
    mainnet: 'https://api.etherscan.io/api',
    sepolia: 'https://api-sepolia.etherscan.io/api',
    polygon: 'https://api.polygonscan.com/api',
    bsc: 'https://api.bscscan.com/api',
  };

  constructor(private config: EtherscanConfig) {}

  /**
   * Verify contract signatures against Etherscan
   */
  public async verifyContract(
    contractAddress: string,
    localSignatures: any
  ): Promise<VerificationResult> {
    try {
      const abi = await this.fetchContractABI(contractAddress);
      return this.compareSignatures(contractAddress, localSignatures, abi);
    } catch (error) {
      throw new Error(`Failed to verify contract: ${error}`);
    }
  }

  /**
   * Fetch contract ABI from Etherscan
   */
  private async fetchContractABI(contractAddress: string): Promise<any[]> {
    const endpoint = this.API_ENDPOINTS[this.config.network];
    const url = `${endpoint}?module=contract&action=getabi&address=${contractAddress}&apikey=${this.config.apiKey}`;

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);

      const options: https.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Connection: 'keep-alive',
        },
        agent: etherscanAgent,
        timeout: VERIFY_TIMEOUT_MS,
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk: Buffer | string) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (response.status === '1') {
              resolve(JSON.parse(response.result));
            } else {
              reject(new Error(response.result));
            }
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', (err: Error) => {
        reject(new Error(`Etherscan API request failed: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Etherscan API request timed out after ${VERIFY_TIMEOUT_MS}ms`));
      });

      req.end();
    });
  }

  /**
   * Compare local signatures with Etherscan ABI
   */
  private compareSignatures(
    contractAddress: string,
    localSignatures: any,
    etherscanABI: any[]
  ): VerificationResult {
    const matches: { function: string; matched: boolean; etherscanSignature?: string }[] = [];
    const mismatches: string[] = [];
    // const localFuncs = new Set(localSignatures.functions.map((f: any) => f.signature));
    const etherscanFuncs = new Map(
      etherscanABI
        .filter((entry) => entry.type === 'function')
        .map((entry) => {
          const sig = this.buildSignature(entry);
          return [sig, entry];
        })
    );

    // Check local functions against Etherscan
    localSignatures.functions.forEach((func: any) => {
      const etherscanEntry = etherscanFuncs.get(func.signature);
      if (etherscanEntry) {
        matches.push({
          function: func.signature,
          matched: true,
          etherscanSignature: func.signature,
        });
        etherscanFuncs.delete(func.signature);
      } else {
        mismatches.push(func.signature);
        matches.push({
          function: func.signature,
          matched: false,
        });
      }
    });

    // Remaining functions only in Etherscan
    const additionalInEtherscan = Array.from(etherscanFuncs.keys());

    return {
      contractAddress,
      verified: mismatches.length === 0 && additionalInEtherscan.length === 0,
      matches,
      mismatches,
      additionalInEtherscan,
    };
  }

  /**
   * Build signature string from ABI entry
   */
  private buildSignature(abiEntry: any): string {
    const inputs = abiEntry.inputs.map((input: any) => input.type).join(',');
    return `${abiEntry.name}(${inputs})`;
  }

  /**
   * Generate verification report
   */
  public generateVerificationReport(result: VerificationResult): string {
    let report = `# Etherscan Verification Report\n\n`;
    report += `**Contract**: ${result.contractAddress}\n`;
    report += `**Status**: ${result.verified ? '✅ Verified' : '❌ Mismatches Found'}\n\n`;

    if (result.matches.length > 0) {
      report += '## Matched Signatures\n\n';
      const matched = result.matches.filter((m) => m.matched);
      report += `- **Total Matches**: ${matched.length}\n\n`;
      matched.forEach((match) => {
        report += `- ✅ ${match.function}\n`;
      });
      report += '\n';
    }

    if (result.mismatches.length > 0) {
      report += '## Mismatches (In Local but not in Etherscan)\n\n';
      result.mismatches.forEach((sig) => {
        report += `- ❌ ${sig}\n`;
      });
      report += '\n';
    }

    if (result.additionalInEtherscan.length > 0) {
      report += '## Additional Functions (In Etherscan but not in Local)\n\n';
      result.additionalInEtherscan.forEach((sig) => {
        report += `- ⚠️ ${sig}\n`;
      });
      report += '\n';
    }

    return report;
  }

  /**
   * Batch verify multiple contracts
   */
  public async verifyMultipleContracts(
    contracts: Map<string, any>
  ): Promise<Map<string, VerificationResult>> {
    const results = new Map<string, VerificationResult>();

    for (const [address, signatures] of contracts.entries()) {
      try {
        const result = await this.verifyContract(address, signatures);
        results.set(address, result);
        // Rate limiting
        await this.delay(200);
      } catch (error) {
        console.error(`Failed to verify ${address}:`, error);
      }
    }

    return results;
  }

  /**
   * Delay helper for rate limiting
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
