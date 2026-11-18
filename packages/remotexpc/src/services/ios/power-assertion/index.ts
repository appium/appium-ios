import {formatValue} from '../../../lib/format-error.js';
import {getLogger} from '../../../lib/logger.js';
import type {PlistDictionary, PowerAssertionService as PowerAssertionServiceInterface} from '../../../lib/types.js';
import {type ServiceConnection} from '../../../service-connection.js';
import {BaseService} from '../base-service.js';

const log = getLogger('PowerAssertionService');

/**
 * Power assertion types that can be used to prevent system sleep
 */
export enum PowerAssertionType {
  WIRELESS_SYNC = 'AMDPowerAssertionTypeWirelessSync',
  PREVENT_USER_IDLE_SYSTEM_SLEEP = 'PreventUserIdleSystemSleep',
  PREVENT_SYSTEM_SLEEP = 'PreventSystemSleep',
}

/**
 * Options for power assertion creation
 */
export interface PowerAssertionOptions {
  type: PowerAssertionType;
  name: string;
  timeout: number; // timeout in seconds
  details?: string;
}

/**
 * PowerAssertionService provides an API to create power assertions.
 *
 * The assertion agent takes a single command per connection and ties the assertion to it: the
 * assertion is released when its timeout elapses (the device then closes the connection) or when
 * the connection is closed, whichever comes first. Anything else sent on that connection makes
 * the agent drop it, so every assertion is held on a connection of its own.
 */
class PowerAssertionService extends BaseService implements PowerAssertionServiceInterface {
  static readonly RSD_SERVICE_NAME = 'com.apple.mobile.assertion_agent.shim.remote';

  private readonly _conns = new Set<ServiceConnection>();
  /** Bumped by `close()`, so a creation that was still connecting knows it must not hold its assertion. */
  private _generation = 0;

  /**
   * Create a power assertion to prevent system sleep. It is held until its timeout elapses or
   * `close()` is called.
   * @param options Options for creating the power assertion
   * @returns Promise that resolves when the device has created the assertion
   * @throws {Error} If the device rejects the request, or `close()` is called before it is sent
   */
  async createPowerAssertion(options: PowerAssertionOptions): Promise<void> {
    const generation = this._generation;
    const conn = await this.startLockdownService(PowerAssertionService.RSD_SERVICE_NAME);
    if (generation !== this._generation) {
      conn.close();
      throw new Error(`Power assertion "${options.name}" was not created: the service was closed`);
    }
    this._conns.add(conn);
    conn.getSocket().once('close', () => this.release(conn));
    try {
      const response = await conn.sendPlistRequest(this.buildCreateAssertionRequest(options));
      if (response.ErrorKey !== undefined) {
        throw new Error(`Failed to create power assertion "${options.name}": ${formatValue(response.ErrorKey)}`);
      }
    } catch (error) {
      this.release(conn);
      throw error;
    }
    log.info(`Power assertion created: type="${options.type}", name="${options.name}", timeout=${options.timeout}s`);
  }

  /**
   * Release every power assertion that is still held, and stop any that is still being created
   */
  async close(): Promise<void> {
    this._generation++;
    for (const conn of this._conns) {
      this.release(conn);
    }
  }

  /**
   * Close the connection holding an assertion exactly once, which releases the assertion
   */
  private release(conn: ServiceConnection): void {
    if (this._conns.delete(conn)) {
      conn.close();
      log.debug('Power assertion connection closed');
    }
  }

  private buildCreateAssertionRequest(options: PowerAssertionOptions): PlistDictionary {
    const request: PlistDictionary = {
      CommandKey: 'CommandCreateAssertion',
      AssertionTypeKey: options.type,
      AssertionNameKey: options.name,
      AssertionTimeoutKey: options.timeout,
    };

    if (options.details !== undefined) {
      request.AssertionDetailKey = options.details;
    }

    return request;
  }
}

export {PowerAssertionService};
