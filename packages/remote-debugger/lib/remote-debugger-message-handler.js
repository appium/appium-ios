import log from './logger';
import _ from 'lodash';


export default class RpcMessageHandler {
  constructor (specialHandlers) {
    this.setHandlers();
    this.errorHandlers = {};
    this.specialHandlers = _.clone(specialHandlers);
    this.dataHandlers = {};
    this.willNavigateWithoutReload = false;
  }

  setDataMessageHandler (key, errorHandler, handler) {
    this.errorHandlers[key] = errorHandler;
    this.dataHandlers[key] = handler;
  }

  setSpecialMessageHandler (key, errorHandler, handler) {
    this.errorHandlers[key] = errorHandler;
    this.specialHandlers[key] = handler;
  }

  setTimelineEventHandler (timelineEventHandler) {
    this.timelineEventHandler = timelineEventHandler;
  }

  hasErrorHandler (key) {
    return _.has(this.errorHandlers, key);
  }

  hasSpecialMessageHandler (key) {
    return _.has(this.specialHandlers, key);
  }

  allowNavigationWithoutReload (allow = true) {
    this.willNavigateWithoutReload = allow;
  }

  handleMessage (plist) {
    let handlerFor = plist.__selector;
    if (!handlerFor) {
      log.debug('Got an invalid plist');
      return;
    }

    if (_.has(this.handlers, handlerFor)) {
      this.handlers[handlerFor](plist);
    } else {
      log.debug(`Debugger got a message for '${handlerFor}' and have no ` +
                `handler, doing nothing.`);
    }
  }

  handleSpecialMessage (handler, ...args) {
    let fn = this.specialHandlers[handler];
    if (fn) {
      // most responses are only to be called once, then
      // removed. But not the ones below, which handle
      // page change and app connect/disconnect
      if (handler !== '_rpc_forwardGetListing:' &&
          handler !== '_rpc_applicationDisconnected:' &&
          handler !== '_rpc_applicationConnected:') {
        this.specialHandlers[handler] = null;
      }
      fn(...args);
    } else {
      log.warn(`Tried to access special message handler '${handler}' ` +
               `but none was found`);
    }
  }

  async handleDataMessage (plist) {
    let dataKey = JSON.parse(plist.__argument.WIRMessageDataKey.toString('utf8'));
    let msgId = dataKey.id;
    let result = dataKey.result;
    let error = dataKey.error || null;

    // we can get an error, or we can get a response that is an error
    if (result && result.wasThrown) {
      let message = result.result.value || result.result.description;
      error = new Error(message);
    }

    if (!_.isNull(msgId) && !_.isUndefined(msgId)) {
      msgId = msgId.toString();
    }
    if (error) {
      if (this.hasErrorHandler(msgId)) {
        this.errorHandlers[msgId](error);
      } else {
        log.error(`Error occurred in handling data message: ${error}`);
        log.error('No error handler present, ignoring');
      }

      // short circuit
      return;
    }

    if (dataKey.method === 'Profiler.resetProfiles') {
      log.debug('Device is telling us to reset profiles. Should probably ' +
                'do some kind of callback here');
    } else if (dataKey.method === 'Page.frameNavigated') {
      if (!this.willNavigateWithoutReload && !this.pageLoading) {
        log.debug('Frame navigated, unloading page');
        this.specialHandlers['Page.frameNavigated']('remote-debugger');
        this.specialHandlers['Page.frameNavigated'] = null;
      } else {
        log.debug('Frame navigated but we were warned about it, not ' +
                  'considering page state unloaded');
        this.willNavigateWithoutReload = false;
      }
    } else if (dataKey.method === 'Page.loadEventFired') {
      await this.pageLoad();
    } else if (dataKey.method === 'Timeline.eventRecorded') {
      this.timelineEventHandler(dataKey.params.record);
    } else if (_.isFunction(this.dataHandlers[msgId])) {
      log.debug('Found data handler for response');
      // we will either get back a result object that has a result.value
      // in which case that is what we want,
      // or else we return the whole thing
      if (result.result && result.result.value) {
        result = result.result.value;
      }
      this.dataHandlers[msgId](result);
      this.dataHandlers[msgId] = null;
    } else if (this.dataHandlers[msgId] === null) {
      log.error(`Debugger returned data for message ${msgId} ` +
                `but we already ran that callback! WTF??`);
    } else {
      if (!msgId && !result && !error) {
        log.debug('Got a blank data response from debugger');
      } else {
        log.error(`Debugger returned data for message ${msgId} ` +
                  `but we were not waiting for that message! ` +
                  `result: ${JSON.stringify(result)}; ` +
                  `error: ${error}`);
      }
    }
  }

  setHandlers () {
    this.handlers = {
      '_rpc_reportSetup:': (plist) => {
        this.handleSpecialMessage('_rpc_reportIdentifier:',
            plist.__argument.WIRSimulatorNameKey,
            plist.__argument.WIRSimulatorBuildKey,
            plist.__argument.WIRSimulatorProductVersionKey);
      },
      '_rpc_reportConnectedApplicationList:': (plist) => {
        this.handleSpecialMessage('_rpc_reportConnectedApplicationList:',
            plist.__argument.WIRApplicationDictionaryKey);
      },
      '_rpc_applicationSentListing:': (plist) => {
        this.handleSpecialMessage('_rpc_forwardGetListing:',
            plist.__argument.WIRApplicationIdentifierKey,
            plist.__argument.WIRListingKey);
      },
      '_rpc_applicationConnected:': (plist) => {
        this.handleSpecialMessage('_rpc_applicationConnected:',
            plist.__argument);
      },
      '_rpc_applicationDisconnected:': (plist) => {
        this.handleSpecialMessage('_rpc_applicationDisconnected:',
            plist.__argument);
      },
      '_rpc_applicationSentData:': this.handleDataMessage.bind(this),
    };
  }
}
